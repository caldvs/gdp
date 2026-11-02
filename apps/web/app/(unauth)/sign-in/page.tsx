'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useDevEmailSignIn, useStartEmailOtp, useVerifyEmailOtp } from '@gdp/core/api/hooks/useEmailOtp';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { decodePayoutFromQR, readPayoutFragment } from '@gdp/core/lib/qrPayload';
import { DEV_SIGNED_OUT_KEY, DEV_SIGNIN_ENABLED } from '@/lib/config';
import { peekJoinFragment } from '@/lib/joinFragment';
import Link from 'next/link';
import { Box, Button, Notice, Page, Row, Section, Title } from '@/components/ui';

type Stage = 'EMAIL' | 'AWAITING_CODE';
const LAST_EMAIL_KEY = 'gdp.dev.lastEmail';
const RESEND_LOCKOUT_SECONDS = 30;
// The email a code was sent to, so the code step survives the tab being
// reloaded or discarded while the user fetches the code (common on phones).
// Kept for the code's lifetime (10 minutes on the API).
const PENDING_CODE_KEY = 'gdp.signIn.pendingCode';
const PENDING_CODE_MS = 10 * 60 * 1000;

function readPendingCode(): string | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_CODE_KEY);
    if (!raw) return null;
    const { email, sentAt } = JSON.parse(raw) as { email?: unknown; sentAt?: unknown };
    if (typeof email === 'string' && typeof sentAt === 'number' && Date.now() - sentAt < PENDING_CODE_MS) return email;
    window.sessionStorage.removeItem(PENDING_CODE_KEY);
  } catch {}
  return null;
}

function writePendingCode(email: string | null) {
  try {
    if (email) window.sessionStorage.setItem(PENDING_CODE_KEY, JSON.stringify({ email, sentAt: Date.now() }));
    else window.sessionStorage.removeItem(PENDING_CODE_KEY);
  } catch {}
}

/**
 * The front door. Signed-out visitors see what the app does and sign in
 * with an email code. Arriving from a join link shows whose bill it is.
 */
export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  );
}

type Invite = { code: string; hostName: string | null };

function useInvite(): Invite | null {
  const from = useSearchParams().get('from');
  const [hostName, setHostName] = useState<string | null>(null);
  const code = from?.match(/^\/join\/([A-Za-z0-9]{4,12})/)?.[1]?.toUpperCase() ?? null;
  useEffect(() => {
    if (!code) return;
    const decoded = decodePayoutFromQR(readPayoutFragment(peekJoinFragment()));
    if (decoded.ok) setHostName(decoded.account.accountHolderName.trim() || null);
  }, [code]);
  return code ? { code, hostName } : null;
}

function Landing() {
  const invite = useInvite();

  if (invite) {
    const first = invite.hostName?.split(' ')[0];
    return (
      <Page>
        <Title title={first ? `Join ${first}’s bill` : 'Join a bill'} sub={`Code ${invite.code}. Sign in with your email to pick what you had.`} />
        <EmailOtpFlow cta="Continue" />
      </Page>
    );
  }

  return (
    <Page>
      <Title title="Split the bill, get paid back" sub="Scan the bill. Friends pick what they had and pay you by bank transfer." />
      <Box>
        <Row title="1. Scan the bill" sub="We read the items and prices." />
        <Row title="2. Share a code with the table" sub="Friends open it on their phones." />
        <Row title="3. Everyone pays you back" sub="Straight to your bank account." />
      </Box>
      <Section title="Sign in or create an account">
        <EmailOtpFlow cta="Email me a code" />
      </Section>
      <p className="muted">Got a code from a friend? <Link href="/join">Join a bill</Link></p>
      <nav className="legal-links" aria-label="Legal">
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/refunds">Refunds</Link>
      </nav>
    </Page>
  );
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

function EmailOtpFlow({ cta }: { cta: string }) {
  const router = useRouter();
  const dest = useDestination();
  const [stage, setStage] = useState<Stage>('EMAIL');
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [resendCountdown, setResendCountdown] = useState(0);
  const startOtp = useStartEmailOtp();
  const verifyOtp = useVerifyEmailOtp();
  const devSignIn = useDevEmailSignIn();
  const [devAvailable, setDevAvailable] = useState(DEV_SIGNIN_ENABLED);

  // Back on the code step if a code was sent from this tab recently.
  useEffect(() => {
    const pending = readPendingCode();
    if (!pending) return;
    setEmail(pending);
    setStage('AWAITING_CODE');
  }, []);

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
      const started = await startOtp.mutateAsync({ email: trimmed });
      if (started.token) {
        // An exempt address: signed in already, no code.
        router.replace(dest);
        return;
      }
      writePendingCode(trimmed);
      setStage('AWAITING_CODE');
      setCode('');
      setResendCountdown(RESEND_LOCKOUT_SECONDS);
    } catch (err) {
      setEmailError(err instanceof ApiError && err.code === 'INVALID_INPUT'
        ? "The server didn't accept that email."
        : err instanceof ApiError && err.code === 'RATE_LIMITED'
          ? err.message
          : "Couldn't reach the server. Check your connection.");
    }
  };

  // Takes the code as an argument because the auto-submit on the sixth
  // digit fires from the change handler, before `code` state has caught up.
  const handleVerify = async (value: string = code) => {
    const trimmed = value.trim();
    if (trimmed.length !== 6 || verifyOtp.isPending) return;
    try {
      await verifyOtp.mutateAsync({ email, code: trimmed });
      writePendingCode(null);
      router.replace(dest);
    } catch {
      setCode('');
    }
  };

  const handleResend = async () => {
    if (resendCountdown > 0) return;
    setCode('');
    try {
      await startOtp.mutateAsync({ email });
      writePendingCode(email);
      setResendCountdown(RESEND_LOCKOUT_SECONDS);
    } catch {}
  };

  const busy = startOtp.isPending || devSignIn.isPending;

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
            aria-describedby={emailError ? 'email-err' : 'email-hint'}
          />
          {emailError ? <div id="email-err" className="field__err">{emailError}</div> : (
            <div id="email-hint" className="field__hint">{devAvailable ? 'Local dev: no code needed.' : 'We’ll email you a 6-digit code. No password.'}</div>
          )}
        </div>
        <Button type="submit" busy={busy}>{devAvailable ? 'Continue' : cta}</Button>
      </form>
    );
  }

  const canResend = resendCountdown <= 0 && !startOtp.isPending;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void handleVerify(); }} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="field">
        <label htmlFor="otp">6-digit code</label>
        <input
          id="otp"
          className="input input--code"
          value={code}
          onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); if (v.length === 6) void handleVerify(v); }}
          placeholder="123456"
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          maxLength={6}
          disabled={verifyOtp.isPending}
        />
        <div className="field__hint">Sent to <b>{email}</b></div>
      </div>
      {verifyOtp.isError ? <Notice tone="error">That code didn’t work. Check your email, or send a new one.</Notice> : null}
      <Button type="submit" busy={verifyOtp.isPending} disabled={code.length !== 6}>Sign in</Button>
      <div className="btn-row">
        <Button tone="text" onClick={handleResend} disabled={!canResend}>
          {startOtp.isPending ? 'Sending…' : canResend ? 'Resend code' : `Resend in ${resendCountdown}s`}
        </Button>
        {startOtp.error instanceof ApiError && startOtp.error.code === 'RATE_LIMITED' ? <p className="field__err" role="alert">{startOtp.error.message}</p> : null}
        <Button tone="text" onClick={() => { writePendingCode(null); setStage('EMAIL'); setCode(''); verifyOtp.reset(); }}>Different email</Button>
      </div>
    </form>
  );
}
