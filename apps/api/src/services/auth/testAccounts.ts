/**
 * Test accounts: sign in without a code, for testing the app with several
 * people from one person's devices (the lead and a guest can't share an
 * email). Local and dev only, and only for addresses on a reserved domain,
 * so they can never be a real person's account.
 *
 * `.invalid` is reserved by RFC 2606: no such mailbox can exist, so nothing
 * is ever sent to these addresses and nobody can own one.
 */
export const TEST_ACCOUNT_DOMAIN = 'test.invalid';

export const isTestAccountEmail = (email: string): boolean =>
  email.trim().toLowerCase().endsWith(`@${TEST_ACCOUNT_DOMAIN}`);

/** Whether test-account sign-in may be offered. Never in prod, whatever the flag says. */
export const testAccountsAllowed = (appEnv: 'local' | 'dev' | 'prod', flag: boolean): boolean =>
  flag && appEnv !== 'prod';
