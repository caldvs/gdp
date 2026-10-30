// Session token + idle-timeout marker, persisted in localStorage.
//
// Ported from gdp-mobile, where native used expo-secure-store and web
// used localStorage. The web app is the only client now, so this is the
// localStorage path on its own. Not "secure" storage — same trade-off
// the mobile web build already made.
//
// Test accounts (local and dev only) can be signed in for one tab: their
// token goes in sessionStorage and wins over the shared one while it's
// there, so a lead and a guest can be tested side by side in one window.
const TOKEN_KEY = 'gdp.idToken';
const TAB_TOKEN_KEY = 'gdp.tabIdToken';
const LAST_ACTIVE_KEY = 'gdp.lastActiveAt';

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function tabStore(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export async function getStoredToken(): Promise<string | null> {
  return tabStore()?.getItem(TAB_TOKEN_KEY) ?? store()?.getItem(TOKEN_KEY) ?? null;
}

/**
 * Keep the token. `tabOnly` signs in this tab alone (test accounts). A tab
 * that's already signed in on its own stays that way, so signing in again
 * there doesn't change the other tabs.
 */
export async function storeToken(token: string, opts: { tabOnly?: boolean } = {}): Promise<void> {
  if (opts.tabOnly || isTabSignedIn()) tabStore()?.setItem(TAB_TOKEN_KEY, token);
  else store()?.setItem(TOKEN_KEY, token);
}

/** Sign out. In a tab signed in on its own, only that tab's sign-in goes. */
export async function clearToken(): Promise<void> {
  if (isTabSignedIn()) tabStore()?.removeItem(TAB_TOKEN_KEY);
  else store()?.removeItem(TOKEN_KEY);
}

/** Whether this tab has its own sign-in (a test account). */
export function isTabSignedIn(): boolean {
  return !!tabStore()?.getItem(TAB_TOKEN_KEY);
}

export function readLastActive(): number | null {
  const raw = store()?.getItem(LAST_ACTIVE_KEY);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function writeLastActive(ts: number): void {
  store()?.setItem(LAST_ACTIVE_KEY, String(ts));
}

export function clearLastActive(): void {
  store()?.removeItem(LAST_ACTIVE_KEY);
}
