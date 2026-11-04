'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@gdp/core/api';
import { getStoredToken } from '@gdp/core/api/auth';
import { useDevEmailSignIn, useSignInRequest, useStartEmailSignIn } from '@gdp/core/api/hooks/useEmailSignIn';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { DEV_SIGNED_OUT_KEY, DEV_SIGNIN_ENABLED } from '@/lib/config';
import { rememberReturnTo } from '@/lib/signInReturn';
import { Button, Notice, Page, Title } from './ui';

type Stage = 'EMAIL' | 'WAITING';
const LAST_EMAIL_KEY = 'gdp.dev.lastEmail';
const RESEND_LOCKOUT_SECONDS = 30;
// The link this tab is waiting on (email and the secret requestId), so the
// wait survives the tab being reloaded or discarded while the user opens
// their email (common on phones). Kept for the link's lifetime (15 minutes).
const PENDING_KEY = 'gdp.signIn.pending';
const PENDING_MS = 15 * 60 * 1000;

// `code` is the number this tab shows; the link's page asks about it (#138).
type Pending = { email: string; requestId: string; code?: string };

export function readPending(): Pending | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const { email, requestId, code, sentAt } = JSON.parse(raw) as { email?: unknown; requestId?: unknown; code?: unknown; sentAt?: unknown };
    if (typeof email === 'string' && typeof requestId === 'string' && typeof sentAt === 'number' && Date.now() - sentAt < PENDING_MS) {
      return { email, requestId, ...(typeof code === 'string' ? { code } : {}) };
    }
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {}
  return null;
}

function writePending(p: Pending | null) {
  try {
    if (p) window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, sentAt: Date.now() }));
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {}
}

function rememberDevEmail(email: string) {
  try {
    window.localStorage.setItem(LAST_EMAIL_KEY, email);
    window.sessionStorage.removeItem(DEV_SIGNED_OUT_KEY);
  } catch {}
}

function useDestination() {
  return safeInternalPath(useSearchParams().get('from'));
}

/** Email field and button, then *Check your email* while this tab waits on the link. */
export function EmailLinkFlow({ cta, hint = true }: { cta: string; /** The "We’ll email you a link" line, when the page doesn’t already say it. */ hint?: boolean }) {
  const router = useRouter();
  const dest = useDestination();
  const [stage, setStage] = useState<Stage>('EMAIL');
  const [email, setEmail] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [resendCountdown, setResendCountdown] = useState(0);
  const startSignIn = useStartEmailSignIn();
  const devSignIn = useDevEmailSignIn();
  const [devAvailable, setDevAvailable] = useState(DEV_SIGNIN_ENABLED);
  const request = useSignInRequest(stage === 'WAITING' ? requestId : null);

  // Still waiting if a link was sent from this tab recently.
  useEffect(() => {
    const pending = readPending();
    if (!pending) return;
    setEmail(pending.email);
    setRequestId(pending.requestId);
    setCode(pending.code ?? null);
    setStage('WAITING');
  }, []);

  // The link was opened (here or anywhere): this tab is signed in now.
  // `expired` while this browser is signed in (the link was opened in
  // another of its tabs, which shares the sign-in) is signed in too: never
  // tell someone who just signed in that their link expired.
  const qc = useQueryClient();
  const status = request.data?.status;
  useEffect(() => {
    if (status === 'signedIn') {
      writePending(null);
      router.replace(dest);
      return;
    }
    if (status !== 'expired') return;
    let live = true;
    void getStoredToken().then(async (token) => {
      if (!live) return;
      writePending(null);
      setRequestId(null);
      if (token) {
        await qc.invalidateQueries({ queryKey: ['me'] });
        router.replace(dest);
        return;
      }
      setStage('EMAIL');
      setEmailError('Link expired. Send a new one.');
    });
    return () => { live = false; };
  }, [status, dest, router, qc]);

  // Local dev: sign straight back in as the last email used, unless the
  // user just signed out in this tab.
  const autoTried = useRef(false);
  useEffect(() => {
    if (!DEV_SIGNIN_ENABLED || autoTried.current) return;
    autoTried.current = true;
    let last: string | null = null;
    let signedOut = false;
    try {
      last = window.localStorage.getItem(LAST_EMAIL_KEY);
      signedOut = window.sessionStorage.getItem(DEV_SIGNED_OUT_KEY) === '1';
    } catch {}
    if (!last) return;
    setEmail(last);
    if (signedOut) return;
    devSignIn.mutate({ email: last }, { onSuccess: () => router.replace(dest), onError: () => setDevAvailable(false) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (resendCountdown <= 0) return;
    const t = setInterval(() => setResendCountdown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [resendCountdown]);

  /** Email a link; true once this tab is waiting on it (or signed in). */
  const send = async (address: string): Promise<boolean> => {
    const started = await startSignIn.mutateAsync({ email: address });
    if (started.token) {
      // An exempt address: signed in already, no link.
      router.replace(dest);
      return true;
    }
    if (!started.requestId) return false;
    rememberReturnTo(dest);
    writePending({ email: address, requestId: started.requestId, ...(started.code ? { code: started.code } : {}) });
    setRequestId(started.requestId);
    setCode(started.code ?? null);
    setStage('WAITING');
    setResendCountdown(RESEND_LOCKOUT_SECONDS);
    return true;
  };

  const handleStart = async () => {
    setEmailError(null);
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError("That doesn't look like an email address.");
      return;
    }
    setEmail(trimmed);
    if (devAvailable) {
      try {
        await devSignIn.mutateAsync({ email: trimmed });
        rememberDevEmail(trimmed);
        router.replace(dest);
        return;
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404)) {
          setEmailError("Couldn't sign in. Is the local API running?");
          return;
        }
        setDevAvailable(false);
      }
    }
    try {
      if (!(await send(trimmed))) setEmailError("Couldn't reach the server. Check your connection.");
    } catch (err) {
      setEmailError(err instanceof ApiError && err.code === 'INVALID_INPUT'
        ? "The server didn't accept that email."
        : err instanceof ApiError && err.code === 'RATE_LIMITED'
          ? err.message
          : "Couldn't reach the server. Check your connection.");
    }
  };

  const handleResend = async () => {
    if (resendCountdown > 0) return;
    try { await send(email); } catch {}
  };

  const busy = startSignIn.isPending || devSignIn.isPending;

  if (stage === 'EMAIL') {
    return (
      <form onSubmit={(e) => { e.preventDefault(); void handleStart(); }} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            className={emailError ? 'input input--invalid' : 'input'}
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (emailError) setEmailError(null); }}
            placeholder="you@example.com"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect="off"
            enterKeyHint="go"
            disabled={busy}
            aria-invalid={!!emailError}
            aria-describedby={emailError ? 'email-err' : devAvailable || hint ? 'email-hint' : undefined}
          />
          {emailError ? <div id="email-err" className="field__err">{emailError}</div> : devAvailable || hint ? (
            <div id="email-hint" className="field__hint">{devAvailable ? 'Local dev: no link needed.' : 'We’ll email you a link. No password.'}</div>
          ) : null}
        </div>
        <Button type="submit" busy={busy}>{devAvailable ? 'Continue' : cta}</Button>
      </form>
    );
  }

  const canResend = resendCountdown <= 0 && !startSignIn.isPending;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div role="status">
        <Notice tone="info" title="Check your email">
          <div className="muted">{email}</div>
        </Notice>
      </div>
      {code ? (
        <div className="signin-code">
          <span className="small muted">Your number</span>
          <span className="code" data-testid="sign-in-code">{code}</span>
        </div>
      ) : null}
      <div className="btn-row">
        <Button tone="text" onClick={handleResend} disabled={!canResend}>
          {startSignIn.isPending ? 'Sending…' : canResend ? 'Resend' : `Resend in ${resendCountdown}s`}
        </Button>
        {startSignIn.error instanceof ApiError && startSignIn.error.code === 'RATE_LIMITED' ? <p className="field__err" role="alert">{startSignIn.error.message}</p> : null}
        <Button tone="text" onClick={() => { writePending(null); setRequestId(null); setStage('EMAIL'); }}>Different email</Button>
      </div>
    </div>
  );
}

/** M4 on the redesign board: its own screen, reached from Sign in. */
export function SignInScreen() {
  return (
    <Page>
      <Title title="Sign in or create an account" sub="We’ll email you a link. No password." />
      <EmailLinkFlow cta="Email me a link" hint={false} />
    </Page>
  );
}
