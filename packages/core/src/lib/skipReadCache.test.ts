import { beforeEach, describe, expect, it } from 'vitest';
import { getSkipReadCache, setSkipReadCache, skipCacheField } from './skipReadCache';

describe('skip read cache', () => {
  beforeEach(() => window.localStorage.clear());

  it('is off by default and adds nothing to requests', () => {
    expect(getSkipReadCache()).toBe(false);
    expect(skipCacheField()).toEqual({});
  });

  it('turns on and off', () => {
    setSkipReadCache(true);
    expect(getSkipReadCache()).toBe(true);
    expect(skipCacheField()).toEqual({ skipCache: true });
    setSkipReadCache(false);
    expect(getSkipReadCache()).toBe(false);
    expect(window.localStorage.getItem('gdp.test.skipReadCache')).toBeNull();
  });
});
