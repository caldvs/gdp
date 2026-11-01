'use client';

import { useParams } from 'next/navigation';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { Button, Centre, Notice, Spinner } from '@/components/ui';
import { GuestPick, GuestTable } from './guest';
import { Ended, LeadSetup, LeadSettled, LeadTable } from './lead';

/** Routes to the lead's or the guest's view of the bill. */
export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const me = useMe();
  const bill = useBill(session.data?.billId, session.data?.pinnedBillVersion);

  if (session.isPending || (session.isSuccess && bill.isPending) || me.isPending) return <Centre><Spinner /></Centre>;
  if (session.isError || bill.isError) {
    return (
      <Centre>
        <Notice tone="error" title="Couldn’t load the bill.">{session.error?.message ?? bill.error?.message}</Notice>
        <Button tone="secondary" href="/">Back to bills</Button>
      </Centre>
    );
  }
  const s = session.data;
  const b = bill.data;
  if (!s || !b || !me.data) return null;
  const meId = me.data.userId;
  const isCreator = meId === s.creatorUserId;

  if (s.status === 'abandoned') return <Ended s={s} isCreator={isCreator} />;
  if (isCreator) {
    if (s.status === 'setup') return <LeadSetup s={s} b={b} />;
    if (s.status === 'settled') return <LeadSettled s={s} b={b} />;
    return <LeadTable s={s} b={b} meUserId={meId} />;
  }
  const mine = s.participants.find((p) => p.userId === meId);
  // Picks stay open until the guest says they've sent the money; after
  // that they watch the table.
  const sent = mine?.payment.status === 'succeeded' || (mine?.payment.status === 'pending' && !!mine.payment.payerClaimedPaidAt);
  const picking = s.status === 'claiming' && !sent;
  return picking ? <GuestPick s={s} b={b} meUserId={meId} /> : <GuestTable s={s} b={b} meUserId={meId} />;
}
