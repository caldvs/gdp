// Join links carry the lead's bank details in `#p=` (ADR-0002) and sign-in
// links a one-time token in `#t=`. Both are taken out of the address bar as
// soon as the app's JavaScript runs (instrumentation-client.ts, before the
// router starts and anything renders), before the shell waits for
// `/me` or reports a page view (#147). The screens that need them read
// them from here, not from `window.location.hash`.
import { stashJoinFragment } from './joinFragment';

let signInToken: string | null = null;

export function captureSecretFragment(): void {
  if (typeof window === 'undefined') return;
  const { hash, pathname, search } = window.location;
  if (!hash || hash === '#') return;
  if (pathname.startsWith('/join/')) stashJoinFragment(hash);
  else if (pathname === '/sign-in/verify') signInToken = new URLSearchParams(hash.slice(1)).get('t');
  else return;
  try {
    window.history.replaceState(window.history.state, '', pathname + search);
  } catch {}
}

/** The emailed link's token, once. */
export function takeSignInToken(): string | null {
  const t = signInToken;
  signInToken = null;
  return t;
}
