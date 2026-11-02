'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useDevEmailSignIn, useSignInRequest, useStartEmailSignIn } from '@gdp/core/api/hooks/useEmailSignIn';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { decodePayoutFromQR, readPayoutFragment } from '@gdp/core/lib/qrPayload';
import { DEV_SIGNED_OUT_KEY, DEV_SIGNIN_ENABLED } from '@/lib/config';
import { peekJoinFragment } from '@/lib/joinFragment';
import { rememberReturnTo } from '@/lib/signInReturn';
import Link from 'next/link';
import { Button, Notice, Page, Title } from '@/components/ui';

type Stage = 'EMAIL' | 'WAITING';
const LAST_EMAIL_KEY = 'gdp.dev.lastEmail';
const RESEND_LOCKOUT_SECONDS = 30;
// The link this tab is waiting on (email and the secret requestId), so the
// wait survives the tab being reloaded or discarded while the user opens
// their email (common on phones). Kept for the link's lifetime (15 minutes).
const PENDING_KEY = 'gdp.signIn.pending';
const PENDING_MS = 15 * 60 * 1000;

type Pending = { email: string; requestId: string };

function readPending(): Pending | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const { email, requestId, sentAt } = JSON.parse(raw) as { email?: unknown; requestId?: unknown; sentAt?: unknown };
    if (typeof email === 'string' && typeof requestId === 'string' && typeof sentAt === 'number' && Date.now() - sentAt < PENDING_MS) return { email, requestId };
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

/**
 * The front door. Signed-out visitors see what the app does and sign in
 * with an emailed link. Arriving from a join link shows whose bill it is.
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
        <EmailLinkFlow cta="Continue" />
      </Page>
    );
  }

  return (
    <main className="bnb">
      <section className="bnb__hero">
        <div className="bnb__intro">
          <h1 className="bnb__h">Split the bill, get paid back</h1>
          <p className="bnb__sub">Snap the bill. Everyone taps what they had and pays you back.</p>
        </div>
        <div className="bnb__login">
          <h2 className="bnb__login-top">Log in or sign up</h2>
          <div className="bnb__login-body">
            <p className="bnb__welcome">Welcome</p>
            <EmailLinkFlow cta="Email me a link" />
            <div className="bnb__or"><span>or</span></div>
            <Button tone="secondary" href="/join">Join a bill with a code</Button>
          </div>
        </div>
      </section>

      <section className="bnb__how" aria-labelledby="how-h">
        <h2 id="how-h" className="bnb__how-h">How it works</h2>
        <ol className="bnb__cards">
          <li className="bnb__card">
            <div className="bnb__pic bnb__pic--scan" aria-hidden="true">
              <div className="bnb__slip">
                <i /><i /><i /><i /><i className="bnb__slip-total" />
              </div>
              <span className="bnb__corners" />
            </div>
            <b>Scan the bill</b>
            <span>We read every item and price</span>
          </li>
          <li className="bnb__card">
            <div className="bnb__pic bnb__pic--share" aria-hidden="true">
              <div className="bnb__qr">
                <svg viewBox="0 0 21 21" shapeRendering="crispEdges">
                  <path d={QR} fill="currentColor" />
                </svg>
              </div>
            </div>
            <b>Share the code</b>
            <span>Friends join from their phones</span>
          </li>
          <li className="bnb__card">
            <div className="bnb__pic bnb__pic--paid" aria-hidden="true">
              <div className="bnb__note">
                <span className="bnb__note-face">S</span>
                <span className="bnb__note-txt"><b>Sam paid you</b><small>Margherita</small></span>
                <span className="bnb__note-amt">£12.50</span>
              </div>
              <div className="bnb__note bnb__note--2">
                <span className="bnb__note-face bnb__note-face--2">P</span>
                <span className="bnb__note-txt"><b>Priya paid you</b><small>Garlic bread</small></span>
                <span className="bnb__note-amt">£2.75</span>
              </div>
            </div>
            <b>Get paid back</b>
            <span>Straight to your bank</span>
          </li>
        </ol>
      </section>

      <footer className="bnb__foot">
        <nav aria-label="Legal">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/refunds">Refunds</Link>
        </nav>
      </footer>
    </main>
  );
}

/* A made-up 21x21 QR-style pattern: three finder squares and some modules. */
const QR = [
  'M0 0h7v7H0zM1 1v5h5V1zM2 2h3v3H2z',
  'M14 0h7v7h-7zM15 1v5h5V1zM16 2h3v3h-3z',
  'M0 14h7v7H0zM1 15v5h5v-5zM2 16h3v3H2z',
  'M8 0h1v2H8zM10 1h2v1h-2zM9 3h2v2H9zM12 4h1v3h-1zM8 6h2v2H8z',
  'M0 8h2v1H0zM3 8h3v1H3zM2 10h2v2H2zM5 10h1v3H5zM0 12h1v1H0z',
  'M8 9h3v1H8zM12 8h2v2h-2zM9 11h1v3H9zM11 11h3v1h-3zM13 13h2v2h-2zM10 15h2v1h-2z',
  'M15 8h2v1h-2zM18 8h3v2h-3zM16 10h2v3h-2zM19 11h2v1h-2zM15 13h1v1h-1z',
  'M8 16h1v3H8zM10 17h3v1h-3zM9 20h4v1H9zM14 16h2v2h-2zM17 15h1v3h-1zM19 14h2v1h-2zM15 19h3v2h-3zM19 17h2v4h-2z',
].join('');

function rememberDevEmail(email: string) {
  try {
    window.localStorage.setItem(LAST_EMAIL_KEY, email);
    window.sessionStorage.removeItem(DEV_SIGNED_OUT_KEY);
  } catch {}
}

function useDestination() {
  return safeInternalPath(useSearchParams().get('from'));
}

function EmailLinkFlow({ cta }: { cta: string }) {
  const router = useRouter();
  const dest = useDestination();
  const [stage, setStage] = useState<Stage>('EMAIL');
  const [email, setEmail] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
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
    setStage('WAITING');
  }, []);

  // The link was opened (here or anywhere): this tab is signed in now.
  const status = request.data?.status;
  useEffect(() => {
    if (status === 'signedIn') {
      writePending(null);
      router.replace(dest);
    } else if (status === 'expired') {
      writePending(null);
      setRequestId(null);
      setStage('EMAIL');
      setEmailError('Link expired. Send a new one.');
    }
  }, [status, dest, router]);

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
    writePending({ email: address, requestId: started.requestId });
    setRequestId(started.requestId);
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
            aria-describedby={emailError ? 'email-err' : 'email-hint'}
          />
          {emailError ? <div id="email-err" className="field__err">{emailError}</div> : (
            <div id="email-hint" className="field__hint">{devAvailable ? 'Local dev: no link needed.' : 'We’ll email you a link. No password.'}</div>
          )}
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
