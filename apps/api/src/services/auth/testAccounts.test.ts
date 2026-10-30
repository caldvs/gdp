import { describe, it, expect } from 'vitest';
import { isTestAccountEmail, testAccountsAllowed } from './testAccounts.js';

describe('isTestAccountEmail', () => {
  it('accepts only the reserved domain, in any case', () => {
    expect(isTestAccountEmail('bob@test.invalid')).toBe(true);
    expect(isTestAccountEmail(' Bob@TEST.invalid ')).toBe(true);
    expect(isTestAccountEmail('bob@gmail.com')).toBe(false);
    expect(isTestAccountEmail('bob@test.invalid.example.com')).toBe(false);
    expect(isTestAccountEmail('bob@nottest.invalid')).toBe(false);
  });
});

describe('testAccountsAllowed', () => {
  it('follows the flag in local and dev', () => {
    expect(testAccountsAllowed('local', true)).toBe(true);
    expect(testAccountsAllowed('dev', true)).toBe(true);
    expect(testAccountsAllowed('dev', false)).toBe(false);
  });

  it('is never allowed in prod', () => {
    expect(testAccountsAllowed('prod', true)).toBe(false);
  });
});
