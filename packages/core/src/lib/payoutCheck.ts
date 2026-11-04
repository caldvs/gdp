import type { PayoutAccount } from './payoutAccount';

// A fingerprint of the bank details in a join link (#151). The lead's
// device sends it to the session (PUT /v1/sessions/{id}/payout-check);
// the details themselves never leave the device (ADR-0002). A guest's
// device recomputes it from the link's `#p=` details and compares, so a
// link someone re-posted with their own details in it is caught.
//
// PBKDF2-SHA256, salted with the session id and slow on purpose: sort
// code and account number are only about 14 digits, so a fast hash
// could be reversed by anyone holding the session row. 100k rounds
// takes a phone a few tens of milliseconds, once per session.

export const PAYOUT_CHECK_ITERATIONS = 100_000;

/** Everything in the link a guest pays by: name, sort code, account, Monzo, Revolut. */
function canonical(account: PayoutAccount): string {
  return JSON.stringify([
    account.accountHolderName.trim(),
    account.sortCode,
    account.accountNumber,
    account.monzoHandle ?? '',
    account.revolutTag ?? '',
  ]);
}

function subtle(): SubtleCrypto | null {
  return (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle ?? null;
}

/** The fingerprint, as 64 hex characters. Null where WebCrypto isn't available. */
export async function payoutCheckFor(
  sessionId: string,
  account: PayoutAccount,
): Promise<string | null> {
  const s = subtle();
  if (!s) return null;
  const enc = new TextEncoder();
  const key = await s.importKey('raw', enc.encode(canonical(account)), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await s.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: enc.encode(`gdp-payout-check:${sessionId}`),
      iterations: PAYOUT_CHECK_ITERATIONS,
    },
    key,
    256,
  );
  return Array.from(new Uint8Array(bits))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * What a guest's app makes of the details it has: `match` when they're the
 * lead's, `mismatch` when they're not (don't show them), `unchecked` when
 * there's nothing to compare against (older bills, or no WebCrypto).
 */
export type PayoutVerdict = 'match' | 'mismatch' | 'unchecked';

export async function checkPayout(
  sessionId: string,
  account: PayoutAccount,
  expected: string | undefined,
): Promise<PayoutVerdict> {
  if (!expected) return 'unchecked';
  const actual = await payoutCheckFor(sessionId, account);
  if (!actual) return 'unchecked';
  return actual === expected ? 'match' : 'mismatch';
}
