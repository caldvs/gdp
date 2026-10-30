import { useCallback, useEffect, useState } from 'react';
import { readSessionPayout } from './sessionPayout';
import type { PayoutAccount } from './payoutAccount';

// useSessionPayout(sessionId) — guest-side hook returning the lead's
// payout details for this session, sourced from the QR fragment stashed
// at join time. Returns null once the 10-minute TTL has expired (the
// underlying read clears the stale value).
//
// Polls every 30 s so screens stay correct around the TTL boundary
// without needing manual refresh. Cheap — it's a single sessionStorage
// + JSON.parse per tick.

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
