import { useCallback, useEffect, useState } from 'react';
import {
  type PayoutAccount,
  readPayoutAccount,
  savePayoutAccount,
  clearPayoutAccount,
  subscribe,
} from './payoutAccount';

// Hook surface for screens. Mirrors the shape of a react-query result so
// drop-in replacement of `useMe().data.payoutAccount` is straightforward.
//
// On mount, the hook calls readPayoutAccount(). On native that triggers
// the biometric prompt unless the in-memory cache is already warm; on
// web it's a sessionStorage read. Subsequent renders use the cache.

export type UsePayoutAccountState = {
  data: PayoutAccount | null | undefined;
  isPending: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
};

export function usePayoutAccount(): UsePayoutAccountState {
  const [data, setData] = useState<PayoutAccount | null | undefined>(undefined);
  const [isPending, setIsPending] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(async () => {
    setIsPending(true);
    setError(null);
    try {
      const value = await readPayoutAccount();
      setData(value);
    } catch (e) {
      // User cancelled biometric / passcode missing / hardware issue.
      // Treat as "no value available" rather than a fatal error — the
      // screen can re-prompt by tapping retry.
      setError(e instanceof Error ? e : new Error('Could not read payout account'));
      setData(null);
    } finally {
      setIsPending(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Re-render when another caller updates / clears the value (e.g.
    // savePayoutAccount somewhere else in the app).
    const unsub = subscribe(() => {
      void load();
    });
    return unsub;
  }, [load]);

  return { data, isPending, error, refresh: load };
}

// Save hook — exposes `save`, `isSaving`, `error`.
export function useSavePayoutAccount() {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const save = useCallback(async (account: PayoutAccount) => {
    setIsSaving(true);
    setError(null);
    try {
      await savePayoutAccount(account);
    } catch (e) {
      setError(e instanceof Error ? e : new Error('Could not save payout account'));
      throw e;
    } finally {
      setIsSaving(false);
    }
  }, []);

  return { save, isSaving, error };
}

// Clear hook — for "remove my saved details" affordance.
export function useClearPayoutAccount() {
  const [isClearing, setIsClearing] = useState(false);
  const clear = useCallback(async () => {
    setIsClearing(true);
    try {
      await clearPayoutAccount();
    } finally {
      setIsClearing(false);
    }
  }, []);
  return { clear, isClearing };
}
