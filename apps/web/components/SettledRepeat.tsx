'use client';

import { useRouter } from 'next/navigation';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { useForkBill } from '@gdp/core/api/hooks/useForkBill';
import { Button, Dialog, Notice } from './ui';

/**
 * A photo the lead already split and closed (docs/design/analysis-cache.md,
 * step 3): Open shows the closed bill; Start again makes a new bill from
 * its latest version and opens it on Review bill. The old split is left
 * as it was.
 */
export function SettledRepeat({ billId, sessionId, onClose }: { billId: string; sessionId: string; onClose: () => void }) {
  const router = useRouter();
  const session = useSession(sessionId);
  const fork = useForkBill();
  const s = session.data;
  const day = s ? new Date(s.createdAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' }).replace(',', '') : null; // some WebKit builds write "Sat, 31 Oct"
  const title = s ? `You split this${s.venue?.name ? ` at ${s.venue.name}` : ''} on ${day}` : 'You split this before';
  const startAgain = () =>
    fork.mutate({ billId }, { onSuccess: (bill) => router.replace(`/confirm-bill/${bill.billId}`) });

  return (
    <Dialog
      id="settled-t"
      title={title}
      onClose={onClose}
      actions={
        <>
          <Button busy={fork.isPending} onClick={startAgain}>Start again</Button>
          <Button tone="secondary" href={`/session/${sessionId}`} replace>Open</Button>
        </>
      }
    >
      {fork.isError ? <Notice tone="error" title="Couldn’t start again.">{fork.error.message}</Notice> : null}
    </Dialog>
  );
}
