import { describe, it, expect } from 'vitest';
import { isTestAccountEmail, newGuestName, TEST_ACCOUNT_NAMES, testAccountEmail, testPayoutAccount } from './testAccounts';

describe('test accounts', () => {
  it('builds addresses on the reserved domain', () => {
    expect(testAccountEmail(' Bob ')).toBe('bob@test.invalid');
  });

  it('recognises only that domain', () => {
    expect(isTestAccountEmail('bob@TEST.invalid')).toBe(true);
    expect(isTestAccountEmail('bob@gmail.com')).toBe(false);
    expect(isTestAccountEmail(undefined)).toBe(false);
  });

  it('makes four-character guest names', () => {
    expect(newGuestName(() => 0)).toBe('guest-0000');
    expect(newGuestName(() => 0.999999)).toMatch(/^guest-[0-9a-z]{4}$/);
  });

  it('gives every named account full bank details and both handles', () => {
    for (const n of TEST_ACCOUNT_NAMES) {
      const p = testPayoutAccount(n);
      expect(p?.sortCode).toMatch(/^\d{6}$/);
      expect(p?.accountNumber).toMatch(/^\d{8}$/);
      expect(p?.monzoHandle).toBeTruthy();
      expect(p?.revolutTag).toBeTruthy();
    }
    expect(testPayoutAccount(' Diana ')?.accountHolderName).toBe('Diana Test');
  });

  it('gives guests none', () => {
    expect(testPayoutAccount('guest-k3x9')).toBeNull();
  });
});
