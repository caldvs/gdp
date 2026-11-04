// Where it's safe to send someone after sign-in (`?from=`, payout-account's
// return, the emailed link's tab). Only a path on this site: browsers read
// `/\evil.com` as `//evil.com`, drop tabs and newlines from URLs, and some
// routers decode `%5C` back into `\`, so those are refused too (#148).

const BASE = 'https://gdp.invalid';
// Control characters and the backslash, raw or percent-encoded once.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f\\]/;

function decodedOnce(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function looksInternal(p: string): boolean {
  return p.startsWith('/') && !p.startsWith('//') && !UNSAFE.test(p);
}

export function safeInternalPath(from: unknown): string {
  if (typeof from !== 'string' || from.length === 0) return '/';
  if (!looksInternal(from)) return '/';
  const decoded = decodedOnce(from);
  if (decoded === null || !looksInternal(decoded)) return '/';
  try {
    const url = new URL(from, BASE);
    if (url.origin !== BASE) return '/';
  } catch {
    return '/';
  }
  return from;
}
