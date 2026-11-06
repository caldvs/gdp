'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSignOut } from '@gdp/core/api/hooks/useSignOut';
import { useIdleSignOut } from '@gdp/core/lib/idle';
import { stashJoinFragment } from '@/lib/joinFragment';
import { Button, CentreMain, CloseIcon, Dialog, MenuIcon, Notice, Page, Spinner } from './ui';
import { AboutYou } from './PhoneSignIn';
import { TestBar } from './TestBar';

/** The site header: name on the left, burger on the right. */
export function Header({ onMenu, menuOpen, wide, signIn, inMenu }: { onMenu?: () => void; menuOpen?: boolean; wide?: boolean; /** The front door: How it works, Pricing and Sign in. */ signIn?: boolean; /** In the menu panel: a plain div, so the page keeps one banner. */ inMenu?: boolean }) {
  const Tag = inMenu ? 'div' : 'header';
  return (
    <Tag className="hdr">
      <div className={wide ? 'hdr__in hdr__in--wide' : 'hdr__in'}>
        <Link href="/" className="brand">
          <span className="brand__mark" aria-hidden><span className="brand__roll"><span>£</span><span>€</span><span>$</span><span>¥</span><span>£</span></span></span>
          Pay Me Back
        </Link>
        {signIn ? (
          <nav className="hdr__nav" aria-label="Front door">
            <a href="#how" className="hdr__nav-link">How it works</a>
            <a href="#pricing" className="hdr__nav-link">Pricing</a>
            <Link href="/sign-in/email" className="hdr__link">Sign in</Link>
          </nav>
        ) : null}
        {onMenu ? (
          <button type="button" className="icon-btn" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={!!menuOpen} aria-controls="main-menu" onClick={onMenu}>
            {menuOpen ? <CloseIcon /> : <MenuIcon />}
          </button>
        ) : null}
      </div>
    </Tag>
  );
}

const MENU = [
  { href: '/', label: 'Bills' },
  { href: '/capture', label: 'Scan a bill' },
  { href: '/join', label: 'Join a bill' },
  null,
  { href: '/account', label: 'Account' },
  { href: '/payout-account', label: 'Bank details' },
] as const;

/** Fades in on open and out on close (X or Escape). A link closes it at once: the page transition takes over. */
function Menu({ email, guest, closing, onClose, onClosed }: { email?: string; /** A guest (#183): their bill and nothing else. */ guest?: { sessionId: string; name: string }; closing: boolean; onClose: () => void; onClosed: () => void }) {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const signOut = useSignOut();
  const first = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // Backstop for the fade-out's animationend (it can be skipped).
  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(onClosed, 300);
    return () => clearTimeout(t);
  }, [closing, onClosed]);

  return (
    <div
      className={closing ? 'menu menu--out' : 'menu'}
      id="main-menu"
      role="dialog"
      aria-modal="true"
      aria-label="Menu"
      onAnimationEnd={(e) => { if (closing && e.target === e.currentTarget) onClosed(); }}
    >
      <Header onMenu={onClose} menuOpen inMenu />
      <nav className="menu__nav" aria-label="Main">
        <ul className="menu__list">
          {guest ? (
            <li>
              <Link ref={first} href={`/session/${guest.sessionId}`} className="menu__item" aria-current={pathname.startsWith(`/session/${guest.sessionId}`) ? 'page' : undefined} onClick={onClosed}>
                This bill
              </Link>
            </li>
          ) : MENU.map((m, i) => m === null ? <li key={i} className="menu__div" aria-hidden /> : (
            <li key={m.href}>
              <Link ref={i === 0 ? first : undefined} href={m.href} className="menu__item" aria-current={pathname === m.href ? 'page' : undefined} onClick={onClosed}>
                {m.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="menu__foot">
        <div className="menu__foot-in">
          {guest ? <span className="small muted">You joined as {guest.name}</span> : (
            <>
              <span className="small muted">{email}</span>
              <Button tone="text" small onClick={() => { void signOut({ everywhere: true }).then(() => router.replace('/sign-in')); }}>Sign out</Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Auth gate and site chrome for signed-in screens. */
export function AppShell({ children }: { children: ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const [menu, setMenu] = useState<'closed' | 'open' | 'closing'>('closed');
  useEffect(() => setMenu('closed'), [pathname]);

  // Idle sign-out: come back to where you were after signing in again.
  const goToSignIn = useCallback(() => {
    const from = window.location.pathname + window.location.search;
    router.replace(from && from !== '/' ? `/sign-in?from=${encodeURIComponent(from)}` : '/sign-in');
  }, [router]);
  // Guests (#183) never sign in, so they're never signed out for being idle.
  const guestSessionId = me.data?.guestSessionId;
  const idle = useIdleSignOut(!!me.data && !guestSessionId, goToSignIn);

  const status = me.error instanceof ApiError ? me.error.status : 0;
  const unauthenticated = me.isError && (status === 401 || status === 403);
  // The QR's landing page works without signing in: guests join with a name there.
  const publicPath = pathname.startsWith('/join/');

  // A guest's token works for their own bill only: anywhere else goes back to it.
  useEffect(() => {
    if (!guestSessionId || publicPath || pathname.startsWith(`/session/${guestSessionId}`)) return;
    router.replace(`/session/${guestSessionId}`);
  }, [guestSessionId, publicPath, pathname, router]);

  useEffect(() => {
    if (!unauthenticated || publicPath) return;
    // A join link's #p= fragment carries the lead's bank details. It's
    // normally parked on load (lib/secretFragment.ts); this catches one
    // that arrived later, since the redirect below would drop it.
    if (pathname.startsWith('/join/') && window.location.hash) {
      stashJoinFragment(window.location.hash);
    }
    const from = pathname + window.location.search;
    router.replace(from && from !== '/' ? `/sign-in?from=${encodeURIComponent(from)}` : '/sign-in');
  }, [unauthenticated, publicPath, pathname, router]);

  const close = useCallback(() => setMenu((m) => (m === 'open' ? 'closing' : m)), []);
  const closed = useCallback(() => setMenu('closed'), []);

  let body: ReactNode = children;
  if (unauthenticated && publicPath) body = children;
  else if (me.isPending || unauthenticated) body = <CentreMain><Spinner /></CentreMain>;
  // A new phone account (#213): its name, and where bill emails go, first.
  else if (me.data?.needsName) body = <Page><AboutYou /></Page>;
  else if (me.isError) {
    body = (
      <CentreMain>
        <h1 className="vh">Can’t reach Pay Me Back</h1>
        <Notice tone="error" title="Can’t reach Pay Me Back.">{me.error.message}</Notice>
        <Button tone="secondary" small onClick={() => me.refetch()}>Try again</Button>
      </CentreMain>
    );
  }

  return (
    <div className="app">
      <TestBar />
      <Header onMenu={me.data ? () => setMenu('open') : undefined} />
      {body}
      {idle.warning ? (
        // Two minutes before the idle sign-out (#200, WCAG 2.2.1). Closing it counts as still being here.
        <Dialog id="idle-t" title="Still there?" onClose={idle.stay} actions={<Button onClick={idle.stay} autoFocus>Stay signed in</Button>}>
          <p className="muted">You’ll be signed out within 2 minutes.</p>
        </Dialog>
      ) : null}
      {menu !== 'closed' ? <Menu email={me.data?.email} guest={guestSessionId ? { sessionId: guestSessionId, name: me.data?.displayName ?? 'Guest' } : undefined} closing={menu === 'closing'} onClose={close} onClosed={closed} /> : null}
    </div>
  );
}
