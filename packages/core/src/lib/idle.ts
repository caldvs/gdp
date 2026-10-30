import { useEffect } from 'react';
import { readLastActive, writeLastActive } from '../api/auth';
import { useSignOut } from '../api/hooks/useSignOut';

// Signs the user out after an hour without interaction. The last-active
// time is persisted so a tab reopened the next day starts signed out.
// Ported from gdp-mobile (web branch of useIdleSignOut).
const IDLE_MS = 60 * 60 * 1000;
const THROTTLE_MS = 5_000;
const CHECK_INTERVAL_MS = 60_000;

export function useIdleSignOut(enabled: boolean, onSignedOut?: () => void): void {
  const signOut = useSignOut();

  useEffect(() => {
    if (!enabled) return;
    const doSignOut = () => {
      void signOut().then(() => onSignedOut?.());
    };

    const stored = readLastActive();
    if (stored != null && Date.now() - stored > IDLE_MS) {
      doSignOut();
      return;
    }
    writeLastActive(Date.now());

    let lastWrite = Date.now();
    const markActive = () => {
      const now = Date.now();
      if (now - lastWrite < THROTTLE_MS) return;
      lastWrite = now;
      writeLastActive(now);
    };
    const checkExpiry = () => {
      const ts = readLastActive();
      if (ts != null && Date.now() - ts > IDLE_MS) doSignOut();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') checkExpiry();
      else writeLastActive(Date.now());
    };

    const interval = setInterval(checkExpiry, CHECK_INTERVAL_MS);
    const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart'];
    for (const e of events) window.addEventListener(e, markActive, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(interval);
      for (const e of events) window.removeEventListener(e, markActive);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, signOut, onSignedOut]);
}
