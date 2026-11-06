'use client';

import { ViewTransition, useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import '@/app/transitions.css';

/**
 * Page changes: the old page fades out and the new one fades in while
 * rising 8px. Keyed by path, so every navigation is an exit and an enter.
 * The header sits outside it and the action bar has its own name, so both
 * stay still. It's the page's `<main>`, so a screen's ActionBar (a sibling
 * of its Page) is inside the landmark too. Styles: app/transitions.css.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  useScreenFocus(pathname);
  return (
    <ViewTransition key={pathname} enter="page-in" exit="page-out" default="none">
      <main className="vt-page">{children}</main>
    </ViewTransition>
  );
}

/* ---------- Focus on a new screen (#193) ---------- */

// On a client-side page change focus stays on <body> (or a control in the
// header), and steps within a page aren't announced at all. So the new
// screen's heading takes focus (tabindex -1): screen readers read it, and
// Tab starts from the top of the new screen.

const HEADING = 'main h1';
// The path the last PageTransition settled on, across layouts: null on a
// fresh load, where the browser already starts at the top.
let shownPath: string | null = null;

function focusHeading(): boolean {
  const h = document.querySelector<HTMLElement>(HEADING);
  if (!h) return false;
  if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
  h.focus({ preventScroll: true });
  return true;
}

/** Nothing has focus, or what had it was the old screen's. */
function focusLost(): boolean {
  const a = document.activeElement;
  return !a || a === document.body || !a.isConnected;
}

function useScreenFocus(pathname: string) {
  // A new path: focus its heading once there is one (pages often show a
  // spinner first), unless the new screen already put focus in itself (an
  // autofocused field) or the user has moved on.
  useEffect(() => {
    const from = shownPath;
    shownPath = pathname;
    if (from === null || from === pathname) return;
    const inScreen = () => {
      const a = document.activeElement;
      return !!a && a !== document.body && !!a.closest('main');
    };
    if (inScreen()) return;
    const start = document.activeElement;
    if (focusHeading()) return;
    const mo = new MutationObserver(() => {
      if (inScreen() || (document.activeElement !== start && !focusLost())) { stop(); return; }
      if (focusHeading()) stop();
    });
    const timer = setTimeout(() => stop(), 10_000);
    function stop() { mo.disconnect(); clearTimeout(timer); }
    mo.observe(document.body, { childList: true, subtree: true });
    return stop;
  }, [pathname]);

  // Steps within a path (photo check → reading, picking → paid): when one
  // heading is replaced by another and focus went with the old screen, focus
  // the new one. Not the first heading on a fresh load.
  useEffect(() => {
    let heading = document.querySelector(HEADING);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      const h = document.querySelector(HEADING);
      if (!h || h === heading) return;
      const had = heading;
      heading = h;
      if (!had) return;
      // Give the screen a moment to place focus itself (a dialog handing it back).
      clearTimeout(timer);
      timer = setTimeout(() => { if (focusLost() && document.querySelector(HEADING) === h) focusHeading(); }, 50);
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { mo.disconnect(); clearTimeout(timer); };
  }, []);
}

/**
 * Text that glides to the same-named text on the next page (a bill's name
 * in the list becomes the bill's heading). Unpaired, it fades with its page.
 */
export function Morph({ name, children }: { name?: string; children: ReactNode }) {
  if (!name) return <>{children}</>;
  return (
    <ViewTransition name={name} share="morph" enter="page-in" exit="page-out" default="none">
      <span className="vt-text">{children}</span>
    </ViewTransition>
  );
}

/** The bill's receipt, printing on the reading page and then edited on Check it matches. */
export const BILL_RECEIPT = 'bill-receipt';

/** The shared name for a bill's title, in lists and on the bill itself. */
export const billTitle = (sessionId: string) => `bill-title-${sessionId.replace(/[^\w-]/g, '_')}`;
