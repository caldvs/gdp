/**
 * Test accounts for local and dev: sign in as someone else without a
 * second real email address. The API only accepts this domain (reserved by
 * RFC 2606, so nobody can own an address on it) and only off prod.
 */
export const TEST_ACCOUNT_DOMAIN = 'test.invalid';

export const TEST_ACCOUNT_NAMES = ['alice', 'bob', 'charlie', 'diana'] as const;

export const testAccountEmail = (name: string): string =>
  `${name.trim().toLowerCase()}@${TEST_ACCOUNT_DOMAIN}`;

export const isTestAccountEmail = (email: string | null | undefined): boolean =>
  !!email && email.trim().toLowerCase().endsWith(`@${TEST_ACCOUNT_DOMAIN}`);

/** A fresh guest nobody has used yet: `guest-k3x9`. */
export const newGuestName = (random: () => number = Math.random): string =>
  `guest-${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`;
