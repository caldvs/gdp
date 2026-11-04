// Holds a join link's #p=… fragment from the moment the app loads (see
// secretFragment.ts) until the join screen takes it, across the sign-in
// redirect too. sessionStorage: it's this tab's, and gone when the tab
// closes. Kept in memory as well, for browsers where storage throws.
const KEY = 'gdp.pendingJoinFragment';
let held: string | null = null;

export function stashJoinFragment(hash: string): void {
  held = hash;
  try {
    window.sessionStorage.setItem(KEY, hash);
  } catch {}
}

export function takeJoinFragment(): string | null {
  const v = peekJoinFragment();
  held = null;
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {}
  return v;
}

/** Reads the stashed fragment without consuming it (the join screen takes it). */
export function peekJoinFragment(): string | null {
  try {
    return window.sessionStorage.getItem(KEY) ?? held;
  } catch {
    return held;
  }
}
