import { useCallback, useEffect, useState } from 'react';
import { readSessionPayout } from './sessionPayout';
import type { PayoutAccount } from './payoutAccount';

// useSessionPayout(sessionId) — guest-side hook returning the lead's
// payout details for this session, as accepted from the QR / join link.
// They stay on the device until the guest has paid or GUEST_KEEP_MS
// passes (see sessionPayout.ts).
//
// Re-reads every 30 s so a clear from another tab shows up. Cheap — a
// single localStorage read + JSON.parse per tick.

export function useSessionPayout(sessionId: string | undefined): {
  data: PayoutAccount | null;
  refresh: () => void;
} {
  const [data, setData] = useState<PayoutAccount | null>(() =>
    sessionId ? readSessionPayout(sessionId) : null,
  );

  const refresh = useCallback(() => {
    if (!sessionId) {
      setData(null);
      return;
    }
    setData(readSessionPayout(sessionId));
  }, [sessionId]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  return { data, refresh };
}
