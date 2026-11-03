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
          <p className="home__sub">Snap the receipt. Friends tick what they had and pay you.<span className="home__desk"> No app to download.</span></p>
          <JoinBar />
          <ScanHere />
        </div>
        <ExampleBill />
        <ol className="home__steps">
          <li><span className="home__num" aria-hidden="true">1</span>Snap the bill</li>
          <li><span className="home__num" aria-hidden="true">2</span>Share the QR code</li>
          <li><span className="home__num" aria-hidden="true">3</span>Get paid back</li>
        </ol>
      </section>

      <section id="sign-in" className="home__login" aria-labelledby="login-h">
        <h2 id="login-h" className="home__login-top">Log in or sign up</h2>
        <div className="home__login-body">
          <EmailLinkFlow cta="Email me a link" />
        </div>
      </section>

      <section id="how" className="home__band" aria-labelledby="how-h">
        <div className="home__band-in">
          <h2 id="how-h" className="home__h2">How it works</h2>
          <ol className="home__cards">
            <li className="home__card"><span className="home__num" aria-hidden="true">1</span><b>Snap the bill</b><span>Take a photo of the receipt. Every item is read for you, and you can fix anything that’s off.</span></li>
            <li className="home__card"><span className="home__num" aria-hidden="true">2</span><b>Share the QR code</b><span>Friends scan it at the table. They join with their name, no account needed.</span></li>
            <li className="home__card"><span className="home__num" aria-hidden="true">3</span><b>Get paid back</b><span>Everyone ticks what they had and pays you by bank transfer. You see who’s paid.</span></li>
          </ol>
        </div>
      </section>

      <section id="pricing" className="home__pricing" aria-labelledby="price-h">
        <div className="home__pricing-text">
          <h2 id="price-h" className="home__h2">One free bill a month</h2>
          <p className="home__sub">The person who pays covers a small fee. Friends pay it back in what they owe.</p>
          <ul className="home__key">
            <li><span className="home__key-mark" aria-hidden="true"><Ring width={44} height={30} /></span><span><b>Free</b> · your first bill each month</span></li>
            <li><span className="home__key-mark"><span className="home__fee">£2</span></span><span>every bill after that</span></li>
            <li><span className="home__key-mark"><span className="home__fee">£3</span></span><span>when the bill is over £100</span></li>
            <li><span className="home__key-mark" aria-hidden="true"><span className="home__dot" /></span><span>a new free bill on the 1st</span></li>
          </ul>
        </div>
        <ExampleMonth />
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

const EXAMPLE: { item: string; who: string; tone?: 'paid' | 'open'; desk?: boolean }[] = [
  { item: 'Calamari', who: 'Priya · paid', tone: 'paid' },
  { item: 'Seafood risotto', who: 'Sam' },
  { item: 'Lasagne', who: 'Tom' },
  { item: 'Negroni × 2', who: 'You', desk: true },
  { item: 'Affogato × 2', who: 'Not claimed', tone: 'open' },
];

/** A made-up bill mid-split. Decoration: the words are in the headline. */
function ExampleBill() {
  return (
    <div className="home__example" aria-hidden="true">
      <div className="home__bill">
        <div className="home__bill-top"><b>Gennaro</b><span>£131.29 · 4 people</span></div>
        {EXAMPLE.map((r) => (
          <div key={r.item} className={['home__bill-row', r.tone === 'open' && 'home__bill-row--open', r.desk && 'home__desk-flex'].filter(Boolean).join(' ')}>
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


const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
type Meal = 'std' | 'big';

/** The hand-drawn circle round the free bill. */
function Ring({ width, height, className }: { width: number; height: number; className?: string }) {
  return (
    <svg className={className} aria-hidden="true" width={width} height={height} viewBox="0 0 60 58" preserveAspectRatio="none">
      <path d="M37 5C18 3 4 14 5 30c1 15 15 23 29 22 16-1 23-12 21-26C53 13 42 4 25 8" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * This month as a calendar with three made-up meals: the first is circled
 * as free, the rest show their fee. Tapping a day adds a meal, again makes
 * it a bill over £100, and again takes it away. The page is prerendered,
 * so the month is only filled in once it's in the visitor's browser.
 */
function ExampleMonth() {
  const [month, setMonth] = useState<{ y: number; m: number } | null>(null);
  const [meals, setMeals] = useState<Record<number, Meal>>({ 6: 'std', 14: 'std', 21: 'big' });
  useEffect(() => {
    const now = new Date();
    setMonth({ y: now.getFullYear(), m: now.getMonth() });
  }, []);

  const days = Object.keys(meals).map(Number).sort((a, b) => a - b);
  const first = days[0];
  const fees = days.reduce((sum, d) => sum + (d === first ? 0 : meals[d] === 'big' ? 3 : 2), 0);
  const summary = days.length === 0 ? 'No bills yet' : days.length === 1 ? '1 bill · free' : `${days.length} bills · £${fees} in fees`;
  const cycle = (d: number) => setMeals((prev) => {
    const next = { ...prev };
    if (!prev[d]) next[d] = 'std';
    else if (prev[d] === 'std') next[d] = 'big';
    else delete next[d];
    return next;
  });

  // Six Monday-first weeks: blanks, this month, then next month's first days.
  const cells: ({ kind: 'blank' } | { kind: 'day' | 'next'; n: number })[] = [];
  if (month) {
    const lead = (new Date(month.y, month.m, 1).getDay() + 6) % 7;
    const count = new Date(month.y, month.m + 1, 0).getDate();
    for (let i = 0; i < lead; i++) cells.push({ kind: 'blank' });
    for (let n = 1; n <= count; n++) cells.push({ kind: 'day', n });
    for (let n = 1; cells.length < 42; n++) cells.push({ kind: 'next', n });
  } else {
    while (cells.length < 42) cells.push({ kind: 'blank' });
  }
  const name = month ? MONTHS[month.m] : '';

  return (
    <div className="home__cal">
      <div className="home__cal-top"><b>{name}</b><span>{month?.y}</span></div>
      <div className="home__cal-grid home__cal-wd" aria-hidden="true">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <div className="home__cal-grid" role="group" aria-label={`${name}: pick a day to add a meal`}>
        {cells.map((c, i) => {
          if (c.kind === 'blank') return <span key={i} className="home__cal-cell" />;
          if (c.kind === 'next') {
            return <span key={i} className="home__cal-cell home__cal-next">{c.n}{c.n === 1 ? <span className="home__dot" aria-hidden="true" /> : null}</span>;
          }
          const meal = meals[c.n];
          const free = !!meal && c.n === first;
          const fee = meal === 'big' ? '£3' : '£2';
          return (
            <button key={i} type="button" className={meal ? 'home__cal-cell home__cal-day home__cal-day--meal' : 'home__cal-cell home__cal-day'} onClick={() => cycle(c.n)} aria-pressed={!!meal}>
              {free ? <Ring width={50} height={50} className="home__cal-ring" /> : null}
              <span>{c.n}</span>{meal ? ' ' : null}
              {free ? <small className="home__cal-free">Free</small> : meal ? <small className="home__fee">{fee}</small> : null}
            </button>
          );
        })}
      </div>
      <div className="home__cal-foot">
        <b role="status">{summary}</b>
        <span>Pick a day to add a meal</span>
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
