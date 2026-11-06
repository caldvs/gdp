import { beforeEach, describe, it, expect } from 'vitest';
import { clearToken, getStoredToken, isTabSignedIn, readLastActive, storeToken } from './auth';

describe('session token storage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('a fresh sign-in restarts the idle hour, so a stale one can’t sign it out', async () => {
    window.localStorage.setItem('gdp.lastActiveAt', String(Date.now() - 3 * 60 * 60 * 1000));
    await storeToken('lead');
    expect(Date.now() - readLastActive()!).toBeLessThan(1000);
  });

  it('keeps an ordinary sign-in for every tab', async () => {
    await storeToken('lead');
    expect(window.localStorage.getItem('gdp.idToken')).toBe('lead');
    expect(await getStoredToken()).toBe('lead');
    expect(isTabSignedIn()).toBe(false);
  });

  it('a tab-only sign-in wins in this tab and leaves the shared one alone', async () => {
    await storeToken('lead');
    await storeToken('guest', { tabOnly: true });
    expect(await getStoredToken()).toBe('guest');
    expect(window.localStorage.getItem('gdp.idToken')).toBe('lead');
    expect(isTabSignedIn()).toBe(true);
  });

  it('signing in again in a tab-only tab stays in that tab', async () => {
    await storeToken('lead');
    await storeToken('guest', { tabOnly: true });
    await storeToken('guest2');
    expect(await getStoredToken()).toBe('guest2');
    expect(window.localStorage.getItem('gdp.idToken')).toBe('lead');
  });

  it('signing out of a tab-only tab falls back to the shared sign-in', async () => {
    await storeToken('lead');
    await storeToken('guest', { tabOnly: true });
    await clearToken();
    expect(await getStoredToken()).toBe('lead');
    await clearToken();
    expect(await getStoredToken()).toBeNull();
  });
});
