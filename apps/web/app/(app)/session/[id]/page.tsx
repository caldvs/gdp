'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { Button, Centre, Notice, Spinner } from '@/components/ui';
import { ledger } from '@gdp/core/lib/ledger';
import { GuestPick, GuestTable, owedFor } from './guest';
import { Ended, LeadSetup, LeadSettled, LeadTable } from './lead';

/** Routes to the lead's or the guest's view of the bill. */
export default function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const me = useMe();
  const bill = useBill(session.data?.billId, session.data?.pinnedBillVersion);
  // #121: a guest who has paid is back to picking after "I had something else".
  const [more, setMore] = useState(false);

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
  // Picks stay open until the guest has sent money; after that they watch
  // the table, and can go back to pick more (#121) and top up.
  const sent = !!mine && ledger(mine, owedFor(s, b, mine)).sentPence > 0;
  const picking = s.status === 'claiming' && (!sent || more);
  return picking
    ? <GuestPick s={s} b={b} meUserId={meId} {...(sent ? { onBack: () => setMore(false) } : {})} />
    : <GuestTable s={s} b={b} meUserId={meId} onMore={() => setMore(true)} />;
}
