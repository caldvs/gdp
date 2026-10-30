'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useDevEmailSignIn, useStartEmailOtp, useVerifyEmailOtp } from '@gdp/core/api/hooks/useEmailOtp';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { decodePayoutFromQR, readPayoutFragment } from '@gdp/core/lib/qrPayload';
import { DEV_SIGNED_OUT_KEY, DEV_SIGNIN_ENABLED } from '@/lib/config';
import { peekJoinFragment } from '@/lib/joinFragment';
import { Avatar, Back, Backdrop, Btn, CameraIcon, Fab, Notice, Screen, Sheet, Spin, TopBar } from '@/components/glass';

type Stage = 'EMAIL' | 'AWAITING_CODE';
const DEV_PRESETS = ['alice', 'bob', 'charlie', 'diana'];
const LAST_EMAIL_KEY = 'gdp.dev.lastEmail';
const RESEND_LOCKOUT_SECONDS = 30;

/**
 * The front door. A first visit sees the landing; "Snap a bill" and
 * "Sign in" open the email-code sheet. Arriving from a join link shows
 * who invited you instead.
 *
 * Signing in is still required to do anything, so the sheet is one tap
 * away rather than hidden. Name-only guest join and optional accounts
 * are API work that comes next.
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
  const [open, setOpen] = useState(!!invite);
  useEffect(() => { if (invite) setOpen(true); }, [invite]);

  if (invite) {
    const first = invite.hostName?.split(' ')[0];
    return (
      <Screen>
        <Backdrop tone="soft" />
        <Sheet
          head={
            <header style={{ padding: '14px 20px 6px', display: 'flex', alignItems: 'center', gap: 12 }}>
              <Avatar name={invite.hostName ?? 'Host'} size={44} />
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, lineHeight: 1.2 }}>{invite.hostName ? `${first} invited you` : "You're invited"}</div>
                <div style={{ fontSize: 13, color: 'var(--g-mute)', marginTop: 2 }}>code {invite.code}</div>
              </div>
            </header>
          }
        >
          <EmailOtpFlow cta="Continue" />
          {DEV_SIGNIN_ENABLED ? <DevSignIn /> : null}
        </Sheet>
      </Screen>
    );
  }

  return (
    <Screen>
      <Backdrop tone="soft" />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(to bottom, rgba(11,12,14,0.1) 0%, rgba(11,12,14,0.35) 40%, rgba(11,12,14,0.95) 100%)' }} aria-hidden />
      <TopBar
        left={
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--g-accent)', color: 'var(--g-on-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 800 }} aria-hidden>GD</span>
            <span style={{ fontSize: 15, fontWeight: 600 }}>Group Dine Pay</span>
          </div>
        }
        right={<Fab label="Sign in" onClick={() => setOpen(true)}>Sign in</Fab>}
      />

      {!open ? (
        <div style={{ position: 'absolute', left: 24, right: 24, bottom: 'max(36px, env(safe-area-inset-bottom))', display: 'flex', flexDirection: 'column', gap: 22, zIndex: 2 }}>
          <h1 style={{ fontSize: 38, fontWeight: 700, lineHeight: 1.08, letterSpacing: '-0.02em', margin: 0 }}>Snap the bill.<br />Friends pay you back.</h1>
          <div style={{ display: 'flex', gap: 8 }}>
            {['Snap the bill', 'Friends tick what they had', 'They pay you direct'].map((t, i) => (
              <div key={t} style={{ flex: 1, borderRadius: 16, background: 'rgba(20,22,26,0.7)', backdropFilter: 'blur(16px)', border: '1px solid rgba(255,255,255,0.08)', padding: '12px 12px 10px' }}>
                <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--g-accent)' }}>{i + 1}</div>
                <div style={{ fontSize: 12, color: 'var(--g-ink-2)', marginTop: 2, lineHeight: 1.35 }}>{t}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Btn onClick={() => setOpen(true)} style={{ height: 56, fontSize: 17 }}><CameraIcon />Snap a bill</Btn>
            <Btn tone="ghost" href="/join">I&apos;ve got a code from a friend</Btn>
          </div>
        </div>
      ) : (
        <Sheet
          head={
            <header className="g-sheet__head" style={{ position: 'relative' }}>
              <div style={{ position: 'absolute', left: 8, top: -4 }}><Fab label="Back" icon={<Back />} onClick={() => setOpen(false)} /></div>
              <h1 className="g-sheet__title" style={{ fontSize: 20 }}>Sign in</h1>
              <p className="g-sheet__sub">We&apos;ll email you a code. No password.</p>
            </header>
          }
        >
          <EmailOtpFlow cta="Email me a code" />
          {DEV_SIGNIN_ENABLED ? <DevSignIn /> : null}
        </Sheet>
      )}
    </Screen>
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
      await startOtp.mutateAsync({ email: trimmed });
      setStage('AWAITING_CODE');
      setCode('');
      setResendCountdown(RESEND_LOCKOUT_SECONDS);
    } catch (err) {
      setEmailError(err instanceof ApiError && err.code === 'INVALID_INPUT'
        ? "The server didn't accept that email."
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
      setResendCountdown(RESEND_LOCKOUT_SECONDS);
    } catch {}
  };

  const busy = startOtp.isPending || devSignIn.isPending;

  if (stage === 'EMAIL') {
    return (
      <form onSubmit={(e) => { e.preventDefault(); void handleStart(); }} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div className="g-field">
          <label htmlFor="email" className="g-label" style={{ padding: 0 }}>Email</label>
          <input
            id="email"
            className="g-input"
            type="email"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (emailError) setEmailError(null); }}
            placeholder="you@example.com"
            autoCapitalize="none"
            autoComplete="email"
            autoCorrect="off"
            autoFocus
            disabled={busy}
          />
          {emailError ? <div className="g-error">{emailError}</div> : null}
        </div>
        <Btn type="submit" busy={busy}>{devAvailable ? 'Continue' : cta}</Btn>
        <div className="g-foot-note">
          {devAvailable ? 'local dev · no code needed' : 'New here? The first code makes your account.'}
        </div>
      </form>
    );
  }

  const canResend = resendCountdown <= 0 && !startOtp.isPending;
  return (
    <form onSubmit={(e) => { e.preventDefault(); void handleVerify(); }} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="g-foot-note" style={{ textAlign: 'left' }}>Sent to <b style={{ color: 'var(--g-ink)' }}>{email}</b></div>
      <input
        className="g-input g-input--mono"
        aria-label="6-digit code"
        value={code}
        onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCode(v); if (v.length === 6) void handleVerify(v); }}
        placeholder="123456"
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        maxLength={6}
        disabled={verifyOtp.isPending}
        style={{ textAlign: 'center', fontSize: 26, letterSpacing: '0.3em', height: 60 }}
      />
      {verifyOtp.isError ? <Notice error>That code didn&apos;t work. Check your email, or send a new one.</Notice> : null}
      <Btn type="submit" busy={verifyOtp.isPending} disabled={code.length !== 6}>Sign in</Btn>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: 'var(--g-mute)', padding: '0 4px' }}>
        <button type="button" onClick={handleResend} disabled={!canResend} style={{ background: 'none', border: 0, color: canResend ? 'var(--g-accent)' : 'var(--g-mute)', fontWeight: 600, padding: 0, font: 'inherit', cursor: canResend ? 'pointer' : 'default' }}>
          {startOtp.isPending ? 'Sending…' : canResend ? 'Resend' : `Resend in ${resendCountdown}s`}
        </button>
        <button type="button" onClick={() => { setStage('EMAIL'); setCode(''); verifyOtp.reset(); }} style={{ background: 'none', border: 0, color: 'var(--g-accent)', fontWeight: 600, padding: 0, font: 'inherit', cursor: 'pointer' }}>
          Different email
        </button>
      </div>
      {verifyOtp.isPending ? <div style={{ display: 'flex', justifyContent: 'center' }}><Spin /></div> : null}
    </form>
  );
}

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
      setError(err instanceof ApiError && err.status === 404 ? 'This API has dev sign-in turned off.' : "Couldn't sign in. Is the local API running?");
    }
  };
  return (
    <div style={{ marginTop: 8 }}>
      <div className="g-label">dev accounts</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '8px 8px 0' }}>
        {DEV_PRESETS.map((u) => (
          <button key={u} type="button" className="g-mini-btn" style={{ height: 36 }} disabled={devSignIn.isPending} onClick={() => signInAs(u)}>{u}</button>
        ))}
      </div>
      {error ? <div className="g-error" style={{ padding: '8px 8px 0' }}>{error}</div> : null}
    </div>
  );
}
