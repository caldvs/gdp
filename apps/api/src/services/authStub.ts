import type { IdTokenVerifier } from './auth.js';
import { AppError } from '../errors/AppError.js';
import { userStore } from '../storage/userStore.js';
import type { PayoutAccount } from '../types/users.js';

// Default payout account auto-merged into every dev:* user on first auth.
// Convenience so you don't have to fill in the payout-account form for
// every new test identity. Bank-detail fields are seeded only when missing
// (so manual edits via the form are preserved); monzoHandle is always set
// if missing so the Monzo deep-link button shows up.
const DEV_DEFAULT_PAYOUT: PayoutAccount = {
  sortCode: '040004',
  accountNumber: '16588257',
  accountHolderName: 'Callum Davies',
  monzoHandle: 'callumd',
};

// In-process cache so we only attempt the seed once per userId per process.
const seededOnce = new Set<string>();

async function seedIfMissing(userId: string): Promise<void> {
  if (seededOnce.has(userId)) return;
  seededOnce.add(userId);
  try {
    const existing = await userStore.get(userId);
    // Merge: keep any field the user has explicitly set, fill in the rest
    // from the dev defaults.
    const merged: PayoutAccount = {
      sortCode: existing?.payoutAccount?.sortCode ?? DEV_DEFAULT_PAYOUT.sortCode,
      accountNumber: existing?.payoutAccount?.accountNumber ?? DEV_DEFAULT_PAYOUT.accountNumber,
      accountHolderName:
        existing?.payoutAccount?.accountHolderName ?? DEV_DEFAULT_PAYOUT.accountHolderName,
      ...((existing?.payoutAccount?.monzoHandle ?? DEV_DEFAULT_PAYOUT.monzoHandle)
        ? {
            monzoHandle: existing?.payoutAccount?.monzoHandle ?? DEV_DEFAULT_PAYOUT.monzoHandle,
          }
        : {}),
      ...(existing?.payoutAccount?.revolutTag
        ? { revolutTag: existing.payoutAccount.revolutTag }
        : {}),
    };
    await userStore.setPayoutAccount(userId, merged);
  } catch {
    // Best-effort — failing to seed shouldn't fail auth. The user can set
    // their payout account manually via the form.
  }
}

/**
 * STRICTLY FOR LOCAL DEVELOPMENT — never wire into a deployed environment.
 *
 * Accepts tokens of the form `dev:<userId>` and trusts them. Any other
 * token shape rejects with AUTH_INVALID. Used by the local server when
 * AUTH_BYPASS_LOCAL=true is set, so multi-user e2e scripts can act as
 * arbitrary identities without provisioning real Google accounts.
 *
 * Side effect: on first touch for a given dev userId, kicks off a
 * fire-and-forget seed of a default payoutAccount so the lead can /share
 * a session immediately without filling out the bank-details form.
 *
 * Guards in src/local.ts refuse to start with this enabled when
 * NODE_ENV === 'production' or when the local DDB endpoint isn't set.
 */
export const localStubVerifier: IdTokenVerifier = (token) => {
  if (!token.startsWith('dev:')) {
    return Promise.reject(new AppError('AUTH_INVALID', 'expected dev:<userId> (auth-bypass mode)'));
  }
  const userId = token.slice('dev:'.length);
  if (!userId) {
    return Promise.reject(new AppError('AUTH_INVALID', 'empty userId after dev:'));
  }

  void seedIfMissing(userId);

  return Promise.resolve({
    userId,
    email: `${userId}@dev.local`,
    name: userId,
    // DiceBear renders a deterministic illustrated PNG keyed by the userId.
    // Real images render fine in the small avatar slot on the session screen;
    // initials are awkward and crowded at that size. Personas style is
    // friendly-cartoon and PNG (RN Image can't render SVG natively).
    picture: `https://api.dicebear.com/7.x/personas/png?seed=${encodeURIComponent(userId)}&size=128`,
  });
};
