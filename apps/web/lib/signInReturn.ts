// Where to carry on after an emailed sign-in link is opened in a new tab.
// The tab that asked carries on by itself; this is for the link's tab, in
// case the first one was closed. Paths only: a join link's #p= fragment
// (bank details) stays in the asking tab's sessionStorage, never here.
// localStorage, so a link opened in the same browser can see it.
import { safeInternalPath } from '@gdp/core/lib/redirect';

const KEY = 'gdp.signIn.returnTo';
const MAX_AGE_MS = 30 * 60 * 1000;

export function rememberReturnTo(path: string): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ path: safeInternalPath(path), at: Date.now() }));
  } catch {}
}

/** The path to carry on to, once; '/' when there's none (another browser, or too old). */
export function takeReturnTo(): string {
  try {
    const raw = window.localStorage.getItem(KEY);
    window.localStorage.removeItem(KEY);
    if (!raw) return '/';
    const { path, at } = JSON.parse(raw) as { path?: unknown; at?: unknown };
    if (typeof at !== 'number' || Date.now() - at > MAX_AGE_MS) return '/';
    return safeInternalPath(path);
  } catch {
    return '/';
  }
}
