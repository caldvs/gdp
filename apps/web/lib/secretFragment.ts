// Join links carry the lead's bank details in `#p=` (ADR-0002). It's taken
// out of the address bar as soon as the app's JavaScript runs
// (instrumentation-client.ts, before the router starts and anything
// renders), before the shell waits for `/me` or reports a page view
// (#147). The join screen reads it from joinFragment.ts, not from
// `window.location.hash`.
import { stashJoinFragment } from './joinFragment';

export function captureSecretFragment(): void {
  if (typeof window === 'undefined') return;
  const { hash, pathname, search } = window.location;
  if (!hash || hash === '#') return;
  if (!pathname.startsWith('/join/')) return;
  stashJoinFragment(hash);
  try {
    window.history.replaceState(window.history.state, '', pathname + search);
  } catch {}
}

