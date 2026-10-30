import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetCache,
  clearPayoutAccount,
  readPayoutAccount,
  savePayoutAccount,
  subscribe,
} from './payoutAccount';

const account = {
  sortCode: '040668',
  accountNumber: '00079660',
  accountHolderName: 'Demo User',
};

describe('payoutAccount (web)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    _resetCache();
  });

  it('returns null when nothing is stored', async () => {
    expect(await readPayoutAccount()).toBeNull();
  });

  it('round-trips through sessionStorage', async () => {
    await savePayoutAccount(account);
    _resetCache();
    expect(await readPayoutAccount()).toEqual(account);
    expect(window.localStorage.getItem('gdp.payoutAccount')).toBeNull();
  });

  it('ignores malformed stored values', async () => {
    window.sessionStorage.setItem('gdp.payoutAccount', '{"sortCode":1}');
    expect(await readPayoutAccount()).toBeNull();
  });

  it('notifies subscribers on save and clear', async () => {
    const listener = vi.fn();
    const unsub = subscribe(listener);
    await savePayoutAccount(account);
    await clearPayoutAccount();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(await readPayoutAccount()).toBeNull();
    unsub();
  });
});
