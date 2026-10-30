// Session token + idle-timeout marker, persisted in localStorage.
//
// Ported from gdp-mobile, where native used expo-secure-store and web
// used localStorage. The web app is the only client now, so this is the
// localStorage path on its own. Not "secure" storage — same trade-off
// the mobile web build already made.
const TOKEN_KEY = 'gdp.idToken';
const LAST_ACTIVE_KEY = 'gdp.lastActiveAt';

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export async function getStoredToken(): Promise<string | null> {
  return store()?.getItem(TOKEN_KEY) ?? null;
}

export async function storeToken(token: string): Promise<void> {
  store()?.setItem(TOKEN_KEY, token);
}

export async function clearToken(): Promise<void> {
  store()?.removeItem(TOKEN_KEY);
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
