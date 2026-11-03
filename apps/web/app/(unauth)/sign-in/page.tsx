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
import { QRCodeSVG } from 'qrcode.react';
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
    <main className="home">
      <section className="home__hero">
        <div className="home__intro">
          <h1 className="home__h">Pay the bill.<br />Get paid back.</h1>
          <p className="home__sub">Snap the receipt. Friends tick what they had and pay you. No app to download.</p>
          <JoinBar />
          <ScanHere />
        </div>
        <ExampleBill />
      </section>

      <section id="sign-in" className="home__login" aria-labelledby="login-h">
        <h2 id="login-h" className="home__login-top">Log in or sign up</h2>
        <div className="home__login-body">
          <EmailLinkFlow cta="Email me a link" />
        </div>
      </section>

      <section className="home__band" aria-labelledby="how-h">
        <div className="home__band-in">
          <h2 id="how-h" className="home__h2">How it works</h2>
          <ol className="home__cards">
            <li className="home__card"><span className="home__num" aria-hidden="true">1</span><b>Snap the bill</b><span>Take a photo of the receipt. Every item is read for you, and you can fix anything that’s off.</span></li>
            <li className="home__card"><span className="home__num" aria-hidden="true">2</span><b>Share the QR code</b><span>Friends scan it at the table and join with their name.</span></li>
            <li className="home__card"><span className="home__num" aria-hidden="true">3</span><b>Get paid back</b><span>Everyone ticks what they had and pays you by bank transfer. You see who’s paid.</span></li>
          </ol>
        </div>
      </section>

      <section className="home__pricing" aria-labelledby="price-h">
        <h2 id="price-h" className="home__h2">Pricing</h2>
        <p className="home__sub">The person who pays the bill covers a small fee. Friends pay it back inside what they owe.</p>
        <div className="home__prices">
          <div className="home__price"><span>First bill each month</span><b>Free</b></div>
          <div className="home__price"><span>Every bill after that</span><b>£2</b><span>£3 when the bill is over £100</span></div>
        </div>
      </section>

      <footer className="home__foot">
        <span>© Pay Me Back</span>
        <nav aria-label="Legal">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/refunds">Refunds</Link>
        </nav>
      </footer>

      <div className="actionbar home__bar">
        <div className="actionbar__in actionbar__in--stack">
          <p className="home__bar-note">First bill each month is free</p>
          <div className="btn-row">
            <Button tone="secondary" href="/join">Join a bill</Button>
            <a className="btn btn--primary grow" href="#sign-in">Scan a bill</a>
          </div>
        </div>
      </div>
    </main>
  );
}

/** "Got a code from a friend?": goes to that bill (signing in first if need be). */
function JoinBar() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const clean = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return (
    <form className="home__join" onSubmit={(e) => { e.preventDefault(); if (clean.length >= 4) router.push(`/join/${clean}`); }}>
      <div className="home__join-field">
        <label htmlFor="join-code">Got a code from a friend?</label>
        <input id="join-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Enter it to join their bill" autoCapitalize="characters" autoComplete="off" autoCorrect="off" spellCheck={false} />
      </div>
      <button type="submit" className="home__join-go">
        Join
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
      </button>
    </form>
  );
}

/** Desktop only: a QR that opens the site on the phone in your pocket. */
function ScanHere() {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => setUrl(window.location.origin), []);
  return (
    <div className="home__scan">
      {url ? <QRCodeSVG value={url} size={76} level="M" bgColor="#ffffff" fgColor="#222222" title="Opens Pay Me Back on your phone" /> : <span className="home__scan-blank" />}
      <div>
        <b>Paying for the table?</b>
        <span>Point your phone camera here to scan the bill.</span>
      </div>
    </div>
  );
}

const EXAMPLE: { item: string; who: string; tone?: 'paid' | 'open' }[] = [
  { item: 'Calamari', who: 'Priya · paid', tone: 'paid' },
  { item: 'Seafood risotto', who: 'Sam' },
  { item: 'Lasagne', who: 'Tom' },
  { item: 'Negroni × 2', who: 'You' },
  { item: 'Affogato × 2', who: 'Not claimed', tone: 'open' },
];

/** A made-up bill mid-split. Decoration: the words are in the headline. */
function ExampleBill() {
  return (
    <div className="home__example" aria-hidden="true">
      <div className="home__bill">
        <div className="home__bill-top"><b>Gennaro</b><span>£131.29 · 4 people</span></div>
        {EXAMPLE.map((r) => (
          <div key={r.item} className={r.tone === 'open' ? 'home__bill-row home__bill-row--open' : 'home__bill-row'}>
            <span>{r.item}</span>
            <span className={r.tone === 'paid' ? 'home__pill home__pill--paid' : r.tone === 'open' ? 'home__pill home__pill--open' : 'home__pill'}>{r.who}</span>
          </div>
        ))}
      </div>
      <div className="home__bubble">
        <span className="home__bubble-tick"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg></span>
        Priya paid you £23.50
      </div>
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
