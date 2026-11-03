'use client';

import { useEffect, useState } from 'react';
import { useBillRead } from '@gdp/core/api/hooks/useBillRead';
import { clearPendingRead, getPendingRead, setPendingRead, type PendingRead } from '@gdp/core/lib/pendingRead';
import { Badge, RowLink, Spinner } from './ui';

/**
 * A bill still being read (or just read) in the background, at the top of
 * Bills. It stays until the bill has a session (then it's in the list), so
 * a read bill the lead hasn't shared yet isn't lost.
 */
export function PendingReadRow({ sessionBillIds }: { sessionBillIds: string[] | undefined }) {
  const [pending, setPending] = useState<PendingRead | null>(null);
  useEffect(() => setPending(getPendingRead()), []);
  const read = useBillRead(pending && !pending.billId ? pending.readId : undefined);

  const billId = pending?.billId ?? (read.data?.status === 'done' ? read.data.billId : undefined);
  useEffect(() => {
    if (pending && billId && !pending.billId) setPendingRead({ ...pending, billId });
  }, [pending, billId]);

  const listed = !!billId && !!sessionBillIds?.includes(billId);
  useEffect(() => {
    if (listed && pending) clearPendingRead(pending.readId);
  }, [listed, pending]);

  if (!pending || listed) return null;
  if (billId) {
    return <RowLink href={`/confirm-bill/${billId}`} card strong title="Bill read" sub="Check it, then share" end={<Badge tone="ok">Ready</Badge>} />;
  }
  if (read.data?.status === 'failed' || read.isError) {
    return <RowLink href={`/reading/${pending.readId}`} card strong title="Couldn’t read your bill" sub="Try again" end={<Badge tone="warn">Failed</Badge>} />;
  }
  return <RowLink href={`/reading/${pending.readId}`} card strong title="Reading your bill" sub="Usually a few seconds" end={<Spinner label="Reading" />} />;
}
