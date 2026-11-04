import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, type components } from '../api/index';
import { checkPayout, payoutCheckFor, type PayoutVerdict } from './payoutCheck';
import type { PayoutAccount } from './payoutAccount';

type Session = components['schemas']['Session'];

/**
 * Lead side (#151): when the lead's QR or link carries their bank details,
 * send the session a fingerprint of them, so guests' apps can check the
 * link they got. Only when it differs from the one on the session, and
 * only while the bill is live. Failures are ignored: guests then see the
 * details unchecked, as before.
 */
export function usePublishPayoutCheck(
  session: Session | undefined,
  payout: PayoutAccount | null,
  isHost: boolean,
): void {
  const qc = useQueryClient();
  const sent = useRef<string | null>(null);
  const sessionId = session?.sessionId;
  const current = session?.payoutCheck;
  const live = !!session && session.status !== 'settled' && session.status !== 'abandoned';
  useEffect(() => {
    if (!isHost || !payout || !sessionId || !live) return;
    let cancelled = false;
    void payoutCheckFor(sessionId, payout).then(async (check) => {
      if (cancelled || !check || check === current || check === sent.current) return;
      sent.current = check;
      try {
        const updated = await api<Session>(`/v1/sessions/${sessionId}/payout-check`, {
          method: 'PUT',
          body: { payoutCheck: check },
        });
        qc.setQueryData(['session', sessionId], updated);
      } catch {
        sent.current = null;
      }
    });
    return () => {
      cancelled = true;
    };
  }, [qc, isHost, payout, sessionId, current, live]);
}

/**
 * Guest side (#151): whether the bank details from the join link are the
 * lead's. `checking` until worked out; then see PayoutVerdict.
 */
export function usePayoutVerdict(
  sessionId: string | undefined,
  payout: PayoutAccount | null,
  expected: string | undefined,
): PayoutVerdict | 'checking' {
  const [verdict, setVerdict] = useState<PayoutVerdict | 'checking'>('checking');
  useEffect(() => {
    if (!sessionId || !payout) {
      setVerdict('unchecked');
      return;
    }
    let cancelled = false;
    setVerdict('checking');
    void checkPayout(sessionId, payout, expected).then((v) => {
      if (!cancelled) setVerdict(v);
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId, payout, expected]);
  return verdict;
}
