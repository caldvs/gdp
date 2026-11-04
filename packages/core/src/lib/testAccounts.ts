import type { PayoutAccount } from './payoutAccount';

/**
 * Test accounts for local and dev: sign in as someone else without a
 * second real email address. The API only accepts this domain (reserved by
 * RFC 2606, so nobody can own an address on it) and only off prod.
 */
export const TEST_ACCOUNT_DOMAIN = 'test.invalid';

export const TEST_ACCOUNT_NAMES = ['alice', 'bob', 'charlie', 'diana'] as const;

/**
 * Made-up bank details and handles each named test account starts with, so
 * a lead can get to the QR without typing any. Handles are prefixed so they
 * won't belong to a real Monzo or Revolut user.
 */
export const TEST_PAYOUT_ACCOUNTS: Record<(typeof TEST_ACCOUNT_NAMES)[number], PayoutAccount> = {
  alice: { accountHolderName: 'Alice Test', sortCode: '111111', accountNumber: '11111111', monzoHandle: 'pmbtestalice', revolutTag: 'pmbtestalice' },
  bob: { accountHolderName: 'Bob Test', sortCode: '222222', accountNumber: '22222222', monzoHandle: 'pmbtestbob', revolutTag: 'pmbtestbob' },
  charlie: { accountHolderName: 'Charlie Test', sortCode: '333333', accountNumber: '33333333', monzoHandle: 'pmbtestcharlie', revolutTag: 'pmbtestcharlie' },
  diana: { accountHolderName: 'Diana Test', sortCode: '444444', accountNumber: '44444444', monzoHandle: 'pmbtestdiana', revolutTag: 'pmbtestdiana' },
};

/** The details a test account starts with; null for guests and anyone else. */
export const testPayoutAccount = (name: string): PayoutAccount | null =>
  TEST_PAYOUT_ACCOUNTS[name.trim().toLowerCase() as keyof typeof TEST_PAYOUT_ACCOUNTS] ?? null;

export const testAccountEmail = (name: string): string =>
  `${name.trim().toLowerCase()}@${TEST_ACCOUNT_DOMAIN}`;

export const isTestAccountEmail = (email: string | null | undefined): boolean =>
  !!email && email.trim().toLowerCase().endsWith(`@${TEST_ACCOUNT_DOMAIN}`);

/** A fresh guest nobody has used yet: `guest-k3x9`. */
export const newGuestName = (random: () => number = Math.random): string =>
  `guest-${Math.floor(random() * 36 ** 4).toString(36).padStart(4, '0')}`;
