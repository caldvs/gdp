'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@gdp/core/api';
import { storeToken } from '@gdp/core/api/auth';
import { useStartEmailOtp, useVerifyEmailOtp } from '@gdp/core/api/hooks/useEmailOtp';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { DEV_SIGNIN_ENABLED } from '@/lib/config';
import { BodyText, Button, DisplayText, LinkButton, Mini, Spinner, TextField } from '@/components/ui';

type Stage = 'EMAIL' | 'AWAITING_CODE';
const DEV_PRESETS = ['alice', 'bob', 'charlie', 'diana'];
const RESEND_LOCKOUT_SECONDS = 30;

export default function SignInPage() {
  return (
    <div className="screen screen--narrow signin">
      <div>
        <Image src="/logo.png" alt="Group Dine Pay" width={64} height={64} className="signin__logo" priority />
        <DisplayText size="lg">Sort the bill.</DisplayText>
        <DisplayText size="lg" as="p">Go home.</DisplayText>
        <BodyText className="mt-md">
          Snap the bill, share a QR, get paid direct. Your friends don&apos;t install anything.
        </BodyText>
      </div>
      <Suspense fallback={null}>
        <EmailOtpFlow />
        {DEV_SIGNIN_ENABLED ? <DevSignIn /> : null}
      </Suspense>
    </div>
  );
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
          disabled={startOtp.isPending}
          error={emailError}
        />
        <Button type="submit" disabled={startOtp.isPending}>{startOtp.isPending ? <Spinner /> : 'Email me a code →'}</Button>
        <Mini className="t-center">we&apos;ll send a 6-digit code · no password</Mini>
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

function DevSignIn() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const dest = useDestination();
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const signInAs = async (userId: string) => {
    const trimmed = userId.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      await storeToken(`dev:${trimmed}`);
      await queryClient.invalidateQueries({ queryKey: ['me'] });
      router.replace(dest);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dev-box">
      <Mini>dev sign-in</Mini>
      <p className="gdp-body" style={{ fontSize: 13 }}>Skips email OTP. Backend must run with AUTH_BYPASS_LOCAL=true.</p>
      <div className="dev-presets">
        {DEV_PRESETS.map((u) => (
          <button key={u} type="button" disabled={busy} onClick={() => signInAs(u)}>{u}</button>
        ))}
      </div>
      <form className="dev-row" onSubmit={(e) => { e.preventDefault(); void signInAs(custom); }}>
        <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="custom user id" autoCapitalize="none" disabled={busy} />
        <button type="submit" className="dev-go" disabled={busy || !custom.trim()}>Go</button>
      </form>
    </div>
  );
}
