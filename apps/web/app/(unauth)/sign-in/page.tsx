'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { decodePayoutFromQR, readPayoutFragment } from '@gdp/core/lib/qrPayload';
import { peekJoinFragment } from '@/lib/joinFragment';
import Link from 'next/link';
import { QRCodeSVG } from 'qrcode.react';
import { Button, Page, Title } from '@/components/ui';
import { EmailCodeFlow, readPending, SignInScreen } from '@/components/EmailSignIn';

/**
 * The front door. Signed-out visitors see what the app does; Sign in and
 * Scan a bill go to /sign-in/email. Arriving from a join link shows whose
 * bill it is, and any other redirect here (`?from=`) asks for the email
 * straight away so it isn't lost.
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
  const router = useRouter();
  const from = useSearchParams().get('from');

  // A code sent from this tab is still being waited on: back to that.
  useEffect(() => {
    if (!invite && !from && readPending()) router.replace('/sign-in/email');
  }, [invite, from, router]);

  if (invite) {
    const first = invite.hostName?.split(' ')[0];
    return (
      <Page>
        <Title title={first ? `Join ${first}’s bill` : 'Join a bill'} sub={`Code ${invite.code}. Sign in with your email to pick what you had.`} />
        <EmailCodeFlow cta="Continue" />
      </Page>
    );
  }

  if (from) return <SignInScreen />;

  return (
    <main className="home">
      <section className="home__hero">
        <div className="home__intro">
          <h1 className="home__h">Pay the bill.<br />Get paid back.</h1>
          <p className="home__sub">Snap the receipt. Friends tick what they had and pay you.<span className="home__desk"> No app to download.</span></p>
          <ScanHere />
        </div>
        <ExampleBill />
        <ol className="home__steps">
          <li><span className="home__num" aria-hidden="true">1</span>Snap the bill</li>
          <li><span className="home__num" aria-hidden="true">2</span>Share the QR code</li>
          <li><span className="home__num" aria-hidden="true">3</span>Get paid back</li>
        </ol>
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
          <p className="home__sub">After that, £1 a bill. Your friends pay it back, so it costs you nothing.</p>
          <ul className="home__key">
            <li><span className="home__key-mark" aria-hidden="true"><Ring width={44} height={30} /></span><span><b>Free</b> · your first bill each month</span></li>
            <li><span className="home__key-mark"><span className="home__fee">£1</span></span><span>every bill after that</span></li>
            <li><span className="home__key-mark"><span className="home__fee">£5</span></span><span>10 credits: bills free for everyone</span></li>
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
            <Button grow href={`/sign-in/email?from=${encodeURIComponent('/capture')}`}>Scan a bill</Button>
          </div>
        </div>
      </div>
    </main>
  );
}

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
type Meal = 'std';

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
 * as free, the rest show their £1. Tapping a day adds a meal, and again
 * takes it away. The page is prerendered,
 * so the month is only filled in once it's in the visitor's browser.
 */
function ExampleMonth() {
  const [month, setMonth] = useState<{ y: number; m: number } | null>(null);
  const [meals, setMeals] = useState<Record<number, Meal>>({ 6: 'std', 14: 'std', 21: 'std' });
  useEffect(() => {
    const now = new Date();
    setMonth({ y: now.getFullYear(), m: now.getMonth() });
  }, []);

  const days = Object.keys(meals).map(Number).sort((a, b) => a - b);
  const first = days[0];
  const fees = days.length > 1 ? days.length - 1 : 0;
  const summary = days.length === 0 ? 'No bills yet' : days.length === 1 ? '1 bill · free' : `${days.length} bills · £${fees}, paid back by friends`;
  const cycle = (d: number) => setMeals((prev) => {
    const next = { ...prev };
    if (!prev[d]) next[d] = 'std';
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
          const fee = '£1';
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
