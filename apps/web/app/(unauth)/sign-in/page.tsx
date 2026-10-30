'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useDevEmailSignIn, useStartEmailOtp, useVerifyEmailOtp } from '@gdp/core/api/hooks/useEmailOtp';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { decodePayoutFromQR, readPayoutFragment } from '@gdp/core/lib/qrPayload';
import { peekJoinFragment } from '@/lib/joinFragment';
import { DEV_SIGNED_OUT_KEY, DEV_SIGNIN_ENABLED } from '@/lib/config';
import { BodyText, Button, DisplayText, LinkButton, Mini, Spinner, TextField } from '@/components/ui';

type Stage = 'EMAIL' | 'AWAITING_CODE';
const DEV_PRESETS = ['alice', 'bob', 'charlie', 'diana'];
const LAST_EMAIL_KEY = 'gdp.dev.lastEmail';
const RESEND_LOCKOUT_SECONDS = 30;

export default function SignInPage() {
  return (
    <div className="screen screen--narrow signin">
      <Suspense fallback={<SignInIntro invite={null} />}>
        <Intro />
      </Suspense>
      <Suspense fallback={null}>
        <EmailOtpFlow />
        {DEV_SIGNIN_ENABLED ? <DevSignIn /> : null}
      </Suspense>
    </div>
  );
}

type Invite = { code: string; hostName: string | null };

/**
 * Someone who scanned a lead's QR lands here with ?from=/join/CODE. Tell
 * them why: whose bill, and that it's a quick sign-in, not an app. The
 * host's name comes from the bank details in the stashed #p= fragment
 * (read locally, never sent anywhere); without it we still say it's an
 * invite.
 */
function useInvite(): Invite | null {
  const from = useSearchParams().get('from');
  const [hostName, setHostName] = useState<string | null>(null);
  const code = from?.match(/^\/join\/([A-Za-z0-9]{4,12})/)?.[1]?.toUpperCase() ?? null;
  useEffect(() => {
    if (!code) return;
    const decoded = decodePayoutFromQR(readPayoutFragment(peekJoinFragment()));
    // Expired or not, the name is still the right person to credit.
    if (decoded.ok) setHostName(decoded.account.accountHolderName.trim() || null);
  }, [code]);
  return code ? { code, hostName } : null;
}

function Intro() {
  return <SignInIntro invite={useInvite()} />;
}

function SignInIntro({ invite }: { invite: Invite | null }) {
  if (invite) {
    const first = invite.hostName?.split(' ')[0];
    return (
      <div>
        <Image src="/logo.png" alt="Group Dine Pay" width={64} height={64} className="signin__logo" priority />
        <Mini>invite · code {invite.code}</Mini>
        <DisplayText size="lg" className="mt-xs">
          {invite.hostName ? `${invite.hostName} invited you to split the bill.` : "You've been invited to split the bill."}
        </DisplayText>
        <BodyText className="mt-md">
          Sign in with your email, tick off what you had, and pay {first ?? 'them'} back straight to their bank. Nothing to install.
        </BodyText>
      </div>
    );
  }
  return (
    <div>
      <Image src="/logo.png" alt="Group Dine Pay" width={64} height={64} className="signin__logo" priority />
      <DisplayText size="lg">Sort the bill.</DisplayText>
      <DisplayText size="lg" as="p">Go home.</DisplayText>
      <BodyText className="mt-md">
        Snap the bill, share a QR, get paid direct. Your friends don&apos;t install anything.
      </BodyText>
    </div>
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

function EmailOtpFlow() {
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
  // Local dev: no code step, as long as the local API offers it.
  const [devAvailable, setDevAvailable] = useState(DEV_SIGNIN_ENABLED);

  // Local dev: sign straight back in as the last email used, unless the
  // user just signed out in this tab (then let them pick an account).
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
    devSignIn.mutate(
      { email: last },
      { onSuccess: () => router.replace(dest), onError: () => setDevAvailable(false) },
    );
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
        // This API doesn't offer dev sign-in — use the normal code flow.
        setDevAvailable(false);
      }
    }
    try {
      await startOtp.mutateAsync({ email: trimmed });
      setStage('AWAITING_CODE');
      setCode('');
      setResendCountdown(RESEND_LOCKOUT_SECONDS);
    } catch (err) {
      setEmailError(
        err instanceof ApiError && err.code === 'INVALID_INPUT'
          ? "The server didn't accept that email. Double-check and try again."
          : "Couldn't reach the server. Check your connection and try again.",
      );
    }
  };

  const handleVerify = async () => {
    const trimmed = code.trim();
    if (trimmed.length !== 6 || verifyOtp.isPending) return;
    try {
      await verifyOtp.mutateAsync({ email, code: trimmed });
      router.replace(dest);
    } catch {
      // Server collapses every failure into one 401 — clear and let the
      // inline error nudge towards resend.
      setCode('');
    }
  };

  const handleResend = async () => {
    if (resendCountdown > 0) return;
    setCode('');
    try {
      await startOtp.mutateAsync({ email });
      setResendCountdown(RESEND_LOCKOUT_SECONDS);
    } catch {
      // keep the user on the code stage; they can retry
    }
  };

  const busy = startOtp.isPending || devSignIn.isPending;

  if (stage === 'EMAIL') {
    return (
      <form className="form-card" onSubmit={(e) => { e.preventDefault(); void handleStart(); }} noValidate>
        <TextField
          label="your email"
          type="email"
          value={email}
          onChange={(e) => { setEmail(e.target.value); if (emailError) setEmailError(null); }}
          placeholder="alice@example.com"
          autoCapitalize="none"
          autoComplete="email"
          autoCorrect="off"
          autoFocus
          disabled={busy}
          error={emailError}
        />
        <Button type="submit" disabled={busy}>
          {busy ? <Spinner /> : devAvailable ? 'Continue →' : 'Email me a code →'}
        </Button>
        <Mini className="t-center">
          {devAvailable ? 'local dev · no code needed · same email, same account' : "we'll send a 6-digit code · no password"}
        </Mini>
      </form>
    );
  }

  return (
    <CodeStage
      email={email}
      code={code}
      onCodeChange={setCode}
      onSubmit={handleVerify}
      onResend={handleResend}
      onUseDifferentEmail={() => { setStage('EMAIL'); setCode(''); verifyOtp.reset(); }}
      verifying={verifyOtp.isPending}
      resending={startOtp.isPending}
      resendCountdown={resendCountdown}
      verifyError={verifyOtp.isError}
    />
  );
}

function CodeStage({ email, code, onCodeChange, onSubmit, onResend, onUseDifferentEmail, verifying, resending, resendCountdown, verifyError }: {
  email: string; code: string; onCodeChange: (v: string) => void; onSubmit: () => void; onResend: () => void;
  onUseDifferentEmail: () => void; verifying: boolean; resending: boolean; resendCountdown: number; verifyError: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Auto-submit on the 6th digit (paste / one-time-code autofill).
  useEffect(() => {
    if (code.length === 6 && !verifying) onSubmit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);
  const canResend = resendCountdown <= 0 && !resending;
  return (
    <form className="form-card" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      <Mini>check your inbox</Mini>
      <BodyText>
        We sent a 6-digit code to <b style={{ color: 'var(--ink)' }}>{email}</b>. Valid for ~10 minutes.
      </BodyText>
      <TextField
        ref={inputRef}
        variant="mono"
        aria-label="6-digit code"
        value={code}
        onChange={(e) => onCodeChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
        placeholder="123456"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={6}
        disabled={verifying}
        error={verifyError ? 'Check your email, or request a new one.' : null}
      />
      <Button type="submit" disabled={verifying || code.length !== 6}>{verifying ? <Spinner /> : 'Sign in →'}</Button>
      <div className="gdp-row">
        <LinkButton aria-label="Send the code again" disabled={!canResend} onClick={onResend}>
          {resending ? 'resending…' : canResend ? 'resend code' : `resend in ${resendCountdown}s`}
        </LinkButton>
        <LinkButton onClick={onUseDifferentEmail} disabled={verifying}>use a different email</LinkButton>
      </div>
    </form>
  );
}

// Local dev shortcuts: one tap signs in as <name>@dev.local through the
// same dev email sign-in, so each is a real, returning account.
function DevSignIn() {
  const router = useRouter();
  const dest = useDestination();
  const devSignIn = useDevEmailSignIn();
  const [error, setError] = useState<string | null>(null);
  const signInAs = async (name: string) => {
    setError(null);
    const email = `${name}@dev.local`;
    try {
      await devSignIn.mutateAsync({ email });
      rememberDevEmail(email);
      router.replace(dest);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404
        ? 'This API has dev sign-in turned off.'
        : "Couldn't sign in. Is the local API running?");
    }
  };
  return (
    <div className="dev-box">
      <Mini>dev accounts</Mini>
      <div className="dev-presets">
        {DEV_PRESETS.map((u) => (
          <button key={u} type="button" disabled={devSignIn.isPending} onClick={() => signInAs(u)}>{u}</button>
        ))}
      </div>
      {error ? <p className="gdp-body" style={{ fontSize: 13, color: 'var(--error-ink)' }}>{error}</p> : null}
    </div>
  );
}
