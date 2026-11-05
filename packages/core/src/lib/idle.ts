import { useCallback, useEffect, useRef, useState } from 'react';
import { readLastActive, writeLastActive } from '../api/auth';
import { useSignOut } from '../api/hooks/useSignOut';

// Signs the user out after an hour without interaction, with a "Still
// there?" warning for the last two minutes (#200, WCAG 2.2.1). The
// last-active time is persisted so a tab reopened the next day starts
// signed out, and so activity in one tab keeps the others signed in.
// Ported from gdp-mobile (web branch of useIdleSignOut).
export const IDLE_MS = 60 * 60 * 1000;
/** How long before the sign-out the warning shows. */
export const IDLE_WARN_MS = 2 * 60 * 1000;
const THROTTLE_MS = 5_000;
const CHECK_INTERVAL_MS = 5_000;

/** Pointer, keys and touch, plus focus and scrolling, which screen readers move without either. */
export const IDLE_ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'focusin', 'scroll'] as const;

export type IdleState = 'active' | 'warn' | 'expired';

/** Where an idle clock stands, from the last-active time (null: never stored). */
export function idleState(lastActive: number | null, now: number): IdleState {
  if (lastActive == null) return 'active';
  const idle = now - lastActive;
  if (idle > IDLE_MS) return 'expired';
  if (idle > IDLE_MS - IDLE_WARN_MS) return 'warn';
  return 'active';
}

export type IdleSignOut = {
  /** True for the last two minutes before an idle sign-out. */
  warning: boolean;
  /** *Stay signed in*: restarts the hour. */
  stay: () => void;
};

export function useIdleSignOut(enabled: boolean, onSignedOut?: () => void): IdleSignOut {
  // useSignOut and callers' callbacks are new each render; in refs so a
  // re-render doesn't restart the clock.
  const latestSignOut = useSignOut();
  const signOut = useRef(latestSignOut);
  const signedOut = useRef(onSignedOut);
  useEffect(() => {
    signOut.current = latestSignOut;
    signedOut.current = onSignedOut;
  });
  const [warning, setWarning] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setWarning(false);
      return;
    }
    let done = false;
    const doSignOut = () => {
      if (done) return;
      done = true;
      setWarning(false);
      void signOut.current().then(() => signedOut.current?.());
    };

    const stored = readLastActive();
    if (idleState(stored, Date.now()) === 'expired') {
      doSignOut();
      return;
    }
    // A reload or remount carries on the same hour.
    if (stored == null) writeLastActive(Date.now());

    let lastWrite = Date.now();
    let warned = false;
    const check = () => {
      const state = idleState(readLastActive(), Date.now());
      if (state === 'expired') return doSignOut();
      warned = state === 'warn';
      setWarning(warned);
    };
    // Once the warning is up, only *Stay signed in* counts: focus moving
    // into the warning itself mustn't quietly dismiss it.
    const markActive = () => {
      const now = Date.now();
      if (warned || now - lastWrite < THROTTLE_MS) return;
      lastWrite = now;
      writeLastActive(now);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
      else if (!warned) writeLastActive(Date.now());
    };

    const interval = setInterval(check, CHECK_INTERVAL_MS);
    // Capture, so scrolling inside any element counts, not just the page.
    const opts = { passive: true, capture: true };
    for (const e of IDLE_ACTIVITY_EVENTS) window.addEventListener(e, markActive, opts);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      for (const e of IDLE_ACTIVITY_EVENTS) window.removeEventListener(e, markActive, opts);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled]);

  const stay = useCallback(() => {
    writeLastActive(Date.now());
    setWarning(false);
  }, []);

  return { warning, stay };
}
