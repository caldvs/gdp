import type { IdTokenVerifier } from './auth.js';
import { AppError } from '../errors/AppError.js';
import { userStore } from '../storage/userStore.js';
import type { PayoutAccount } from '../types/users.js';

// Deterministic-per-user dev payout. Each `dev:<userId>` gets a stable
// but distinct sort code + account number + display name, so when one
// guest pays another dev user the guest doesn't see "Callum Davies"
// on every test session. Bank-detail fields are seeded only when
// missing (manual edits via /payout-account form are preserved).
function devPayoutFor(userId: string): PayoutAccount {
  // Cheap deterministic hash — stable across restarts, distinct per
  // user. Not cryptographic; we're just generating fake numbers.
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  const sortCode = String(hash % 1_000_000).padStart(6, '0');
  const accountNumber = String((hash * 17) % 100_000_000).padStart(8, '0');
  const name = userId.charAt(0).toUpperCase() + userId.slice(1) + ' Diner';
  // Deliberately NO monzoHandle / revolutTag here. Previously this
  // function set `monzoHandle: userId`, which on the client side
  // produces a `monzo.me/<userId>` deep link — those handles ARE
  // real on Monzo's public profile site and resolve to unrelated
  // strangers. Without a handle the frontend skips the deep link
  // buttons and the only payment path shown is the (obviously fake)
  // sort code + account number, which goes nowhere.
  return {
    sortCode,
    accountNumber,
    accountHolderName: name,
  };
}

// In-process cache so we only attempt the seed once per userId per process.
const seededOnce = new Set<string>();

async function seedIfMissing(userId: string): Promise<void> {
  if (seededOnce.has(userId)) return;
  seededOnce.add(userId);
  try {
    const existing = await userStore.get(userId);
    const defaults = devPayoutFor(userId);

    // Migration path. Two stale seeds we want to overwrite:
    //   v1: every dev user got "Callum Davies / 040004 / 16588257".
    //   v2: per-user fake bank details BUT monzoHandle = userId, which
    //       resolves to a real (unrelated) Monzo public profile page.
    // Both are overwritten with the new safe defaults (no Monzo handle).
    // Anything else — including manually-entered details from the
    // /payout-account form — is preserved.
    const isV1OldShared =
      existing?.payoutAccount?.accountHolderName === 'Callum Davies' &&
      existing?.payoutAccount?.sortCode === '040004' &&
      existing?.payoutAccount?.accountNumber === '16588257';
    const isV2BadMonzoHandle = existing?.payoutAccount?.monzoHandle === userId;

    if (isV1OldShared || isV2BadMonzoHandle || !existing?.payoutAccount) {
      await userStore.setPayoutAccount(userId, defaults);
      return;
    }

    // Merge: keep any field the user has explicitly set, fill in the rest
    // from the deterministic dev defaults.
    const merged: PayoutAccount = {
      sortCode: existing.payoutAccount.sortCode ?? defaults.sortCode,
      accountNumber: existing.payoutAccount.accountNumber ?? defaults.accountNumber,
      accountHolderName:
        existing.payoutAccount.accountHolderName ?? defaults.accountHolderName,
      ...((existing.payoutAccount.monzoHandle ?? defaults.monzoHandle)
        ? {
            monzoHandle: existing.payoutAccount.monzoHandle ?? defaults.monzoHandle,
          }
        : {}),
      ...(existing.payoutAccount.revolutTag
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
