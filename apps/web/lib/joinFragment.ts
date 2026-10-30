// Holds a join link's #p=… fragment across the sign-in redirect.
// sessionStorage only: it's this tab's, and gone when the tab closes.
const KEY = 'gdp.pendingJoinFragment';

export function stashJoinFragment(hash: string): void {
  try {
    window.sessionStorage.setItem(KEY, hash);
  } catch {}
}

export function takeJoinFragment(): string | null {
  try {
    const v = window.sessionStorage.getItem(KEY);
    window.sessionStorage.removeItem(KEY);
    return v;
  } catch {
    return null;
  }
}
