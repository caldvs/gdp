'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useDevEmailSignIn, useStartEmailSignIn, useVerifyEmailCode } from '@gdp/core/api/hooks/useEmailSignIn';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { DEV_SIGNED_OUT_KEY, DEV_SIGNIN_ENABLED } from '@/lib/config';
import { Button, Page, Title } from './ui';
import { PhoneSignIn } from './PhoneSignIn';
import { useSignInMethods } from '@gdp/core/api/hooks/usePhoneSignIn';

type Stage = 'EMAIL' | 'CODE';
const LAST_EMAIL_KEY = 'gdp.dev.lastEmail';
const RESEND_LOCKOUT_SECONDS = 30;
// The code this tab is waiting on (email and the secret requestId), so it
// survives the tab being reloaded or discarded while the user checks their
// email (common on phones). Kept for the code's lifetime (15 minutes).
const PENDING_KEY = 'gdp.signIn.pending';
const PENDING_MS = 15 * 60 * 1000;
const CODE_LENGTH = 6;

type Pending = { email: string; requestId: string };

export function readPending(): Pending | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const { email, requestId, sentAt } = JSON.parse(raw) as { email?: unknown; requestId?: unknown; sentAt?: unknown };
    if (typeof email === 'string' && typeof requestId === 'string' && typeof sentAt === 'number' && Date.now() - sentAt < PENDING_MS) {
      return { email, requestId };
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

/** Email field and button, then the 6-digit code from the email, in the same tab. */
export function EmailCodeFlow({ cta, hint = true }: { cta: string; /** The "We’ll email you a code" line, when the page doesn’t already say it. */ hint?: boolean }) {
  const router = useRouter();
  const dest = useDestination();
  const [stage, setStage] = useState<Stage>('EMAIL');
  const [email, setEmail] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [resendCountdown, setResendCountdown] = useState(0);
  const startSignIn = useStartEmailSignIn();
  const verify = useVerifyEmailCode();
  const devSignIn = useDevEmailSignIn();
  const [devAvailable, setDevAvailable] = useState(DEV_SIGNIN_ENABLED);
  const codeInput = useRef<HTMLInputElement>(null);

  // Still waiting on a code sent from this tab recently.
  useEffect(() => {
    const pending = readPending();
    if (!pending) return;
    setEmail(pending.email);
    setRequestId(pending.requestId);
    setStage('CODE');
  }, []);

  useEffect(() => {
    if (stage === 'CODE') codeInput.current?.focus();
  }, [stage]);

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

  /** Email a code; true once this tab is waiting on it (or signed in). */
  const send = async (address: string): Promise<boolean> => {
    const started = await startSignIn.mutateAsync({ email: address });
    if (started.token) {
      // An exempt address: signed in already, no code.
      router.replace(dest);
      return true;
    }
    if (!started.requestId) return false;
    writePending({ email: address, requestId: started.requestId });
    setRequestId(started.requestId);
    setCode('');
    setCodeError(null);
    setStage('CODE');
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

  const submitCode = async (entered: string) => {
    if (!requestId || verify.isPending) return;
    if (entered.length !== CODE_LENGTH) {
      setCodeError('Enter the 6-digit code.');
      return;
    }
    setCodeError(null);
    try {
      const res = await verify.mutateAsync({ requestId, code: entered });
      if (res.status === 'signedIn') {
        writePending(null);
        router.replace(dest);
        return;
      }
      setCode('');
      if (res.status === 'wrong') {
        setCodeError(`Wrong code. ${res.attemptsLeft} ${res.attemptsLeft === 1 ? 'try' : 'tries'} left.`);
        codeInput.current?.focus();
        return;
      }
      writePending(null);
      setRequestId(null);
      setCodeError('Code expired. Send a new one.');
    } catch {
      setCodeError("Couldn't reach the server. Check your connection.");
    }
  };

  const onCodeChange = (raw: string) => {
    const digits = raw.replace(/\D/g, '').slice(0, CODE_LENGTH);
    setCode(digits);
    if (codeError) setCodeError(null);
    // Typed, pasted or filled in from the email: go as soon as it's whole.
    if (digits.length === CODE_LENGTH) void submitCode(digits);
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
          {emailError ? <div id="email-err" className="field__err" role="alert">{emailError}</div> : devAvailable || hint ? (
            <div id="email-hint" className="field__hint">{devAvailable ? 'Local dev: no code needed.' : 'We’ll email you a code. No password.'}</div>
          ) : null}
        </div>
        <Button type="submit" busy={busy}>{devAvailable ? 'Continue' : cta}</Button>
      </form>
    );
  }

  const canResend = resendCountdown <= 0 && !startSignIn.isPending;
  const expired = !requestId;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <form onSubmit={(e) => { e.preventDefault(); void submitCode(code); }} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="field">
          <label htmlFor="code">Code sent to {email}</label>
          <input
            ref={codeInput}
            id="code"
            className={codeError ? 'input input--code input--invalid' : 'input input--code'}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => onCodeChange(e.target.value)}
            placeholder="000000"
            enterKeyHint="go"
            disabled={expired || verify.isPending}
            aria-invalid={!!codeError}
            aria-describedby={[codeError ? 'code-err' : '', expired ? '' : 'code-life'].filter(Boolean).join(' ') || undefined}
          />
          {codeError ? <div id="code-err" className="field__err" role="alert">{codeError}</div> : null}
          {expired ? null : <div id="code-life" className="field__hint">Works for 15 minutes.</div>}
        </div>
        {expired ? null : <Button type="submit" busy={verify.isPending}>Continue</Button>}
      </form>
      <div className="btn-row">
        <Button tone={expired ? 'primary' : 'text'} onClick={handleResend} disabled={!canResend}>
          {startSignIn.isPending ? 'Sending…' : canResend ? (expired ? 'Send a new code' : 'Resend') : `Resend in ${resendCountdown}s`}
        </Button>
        {startSignIn.error instanceof ApiError && startSignIn.error.code === 'RATE_LIMITED' ? <p className="field__err" role="alert">{startSignIn.error.message}</p> : null}
        <Button tone="text" onClick={() => { writePending(null); setRequestId(null); setCode(''); setCodeError(null); setStage('EMAIL'); }}>Different email</Button>
      </div>
    </div>
  );
}

/**
 * M4 on the redesign board: its own screen, reached from Sign in. Phone
 * first where this server has it on (#213), with email still a way in until
 * phone sign-in is live everywhere.
 */
export function SignInScreen() {
  const methods = useSignInMethods();
  const [useEmail, setUseEmail] = useState(false);
  if (methods.isPending) return <Page>{null}</Page>;
  if (methods.data?.phone && !useEmail && !readPending()) {
    return (
      <Page>
        <PhoneSignIn channel={methods.data.whatsapp ? 'whatsapp' : 'sms'} onUseEmail={() => setUseEmail(true)} />
      </Page>
    );
  }
  return (
    <Page>
      <Title title="Sign in or create an account" sub="We’ll email you a code. No password." />
      <EmailCodeFlow cta="Email me a code" hint={false} />
    </Page>
  );
}
