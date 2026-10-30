import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  storeSessionPayoutFromFragment,
  readSessionPayout,
  clearSessionPayout,
  scrubFragmentFromUrl,
} from './sessionPayout';
import { encodePayoutForQR } from './qrPayload';

// Per-test sessionStorage shim. Vitest's jsdom doesn't reset state
// between tests in the same file, so we clear manually.
function clearStorage() {
  if (typeof window !== 'undefined') {
    window.sessionStorage.clear();
  }
}

const FRESH_PAYOUT = {
  accountHolderName: 'Alice Cooper',
  sortCode: '040668',
  accountNumber: '00079660',
};

describe('sessionPayout', () => {
  beforeEach(clearStorage);
  afterEach(() => {
    vi.useRealTimers();
    clearStorage();
  });

  it('roundtrips a fresh fragment into readable state', () => {
    const fragment = `#p=${encodePayoutForQR(FRESH_PAYOUT)}`;
    const { stored, reason } = storeSessionPayoutFromFragment('s1', fragment);
    expect(reason).toBeUndefined();
    expect(stored?.accountHolderName).toBe('Alice Cooper');

    const read = readSessionPayout('s1');
    expect(read).toEqual(FRESH_PAYOUT);
  });

  it('returns null when there is nothing stored', () => {
    expect(readSessionPayout('never-stored')).toBeNull();
  });

  it('refuses to store a fragment with no p= param', () => {
    const { stored } = storeSessionPayoutFromFragment('s1', '#foo=bar');
    expect(stored).toBeNull();
  });

  it('refuses a malformed encoded payload', () => {
    const { stored, reason } = storeSessionPayoutFromFragment('s1', '#p=not-base64!');
    expect(stored).toBeNull();
    expect(reason).toBeTruthy();
  });

  it('treats an iat-expired fragment as expired on store', () => {
    // Encode with iat in the past so it's already past TTL.
    const expired = encodePayoutForQR(FRESH_PAYOUT, Date.now() - 11 * 60 * 1000);
    const { stored, reason } = storeSessionPayoutFromFragment('s1', `#p=${expired}`);
    expect(stored).toBeNull();
    expect(reason).toBe('expired');
  });

  it('readSessionPayout re-evaluates TTL on each read and clears expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T12:00:00Z'));
    const fragment = `#p=${encodePayoutForQR(FRESH_PAYOUT)}`;
    storeSessionPayoutFromFragment('s1', fragment);

    expect(readSessionPayout('s1')).not.toBeNull();

    // Advance 11 minutes — past the 10-min TTL.
    vi.setSystemTime(new Date('2026-05-13T12:11:00Z'));
    expect(readSessionPayout('s1')).toBeNull();

    // The expired entry should have been cleared from storage too.
    expect(window.sessionStorage.getItem('gdp.sessionPayout.s1')).toBeNull();
  });

  it('clearSessionPayout removes the entry', () => {
    const fragment = `#p=${encodePayoutForQR(FRESH_PAYOUT)}`;
    storeSessionPayoutFromFragment('s1', fragment);
    expect(readSessionPayout('s1')).not.toBeNull();

    clearSessionPayout('s1');
    expect(readSessionPayout('s1')).toBeNull();
  });

  it('does not collide across different sessionIds', () => {
    const fragmentA = `#p=${encodePayoutForQR(FRESH_PAYOUT)}`;
    const fragmentB = `#p=${encodePayoutForQR({ ...FRESH_PAYOUT, accountHolderName: 'Bob Hartley' })}`;

    storeSessionPayoutFromFragment('s1', fragmentA);
    storeSessionPayoutFromFragment('s2', fragmentB);

    expect(readSessionPayout('s1')?.accountHolderName).toBe('Alice Cooper');
    expect(readSessionPayout('s2')?.accountHolderName).toBe('Bob Hartley');

    clearSessionPayout('s1');
    expect(readSessionPayout('s1')).toBeNull();
    expect(readSessionPayout('s2')?.accountHolderName).toBe('Bob Hartley');
  });

  describe('scrubFragmentFromUrl', () => {
    it('removes the fragment via history.replaceState', () => {
      // jsdom mutates window.location through pushState.
      window.history.pushState(null, '', '/foo?bar=1#p=abc');
      expect(window.location.hash).toBe('#p=abc');

      const spy = vi.spyOn(window.history, 'replaceState');
      scrubFragmentFromUrl();
      expect(spy).toHaveBeenCalledTimes(1);
      const [, , url] = spy.mock.calls[0];
      expect(url).not.toContain('#');
      spy.mockRestore();
    });

    it('no-ops when the URL has no fragment', () => {
      window.history.pushState(null, '', '/foo?bar=1');
      expect(window.location.hash).toBe('');

      const spy = vi.spyOn(window.history, 'replaceState');
      scrubFragmentFromUrl();
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
