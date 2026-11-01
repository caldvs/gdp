import { describe, it, expect } from 'vitest';
import { isTestAccountEmail, newGuestName, testAccountEmail } from './testAccounts';

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
});
