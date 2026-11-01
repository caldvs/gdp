// Local testing: read every bill photo with the model again, even one this
// account has read before. Set from the test bar; the local API honours it
// and every other API ignores it.

const KEY = 'gdp.test.skipReadCache';

export function getSkipReadCache(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setSkipReadCache(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(KEY, '1');
    else window.localStorage.removeItem(KEY);
  } catch {}
}

/** Extra request fields for uploads and reads: `{ skipCache: true }` when on. */
export const skipCacheField = (): { skipCache?: true } =>
  getSkipReadCache() ? { skipCache: true } : {};
