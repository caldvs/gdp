'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSession } from '@gdp/core/api/hooks/useSession';
import type { SessionSummary } from '@gdp/core/api/hooks/useMySessions';
import { BackLink, BillSkeleton, Button, Centre, Notice, Page, Spinner, Title } from '@/components/ui';
import { billTitle } from '@/components/PageTransition';
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

  if (session.isPending || (session.isSuccess && bill.isPending) || me.isPending) return <Loading id={id} />;
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

/**
 * While the bill loads, show its name as the heading if the bills list has
 * it, so the name can glide there from the list (components/PageTransition).
 * Only where the loaded view's heading will be that name too.
 */
function Loading({ id }: { id: string }) {
  const summary = useCachedSummary(id);
  const name = summary?.venue?.name;
  if (!summary || !name || !headedByVenue(summary)) return <Centre><Spinner /></Centre>;
  return (
    <Page sub>
      <BackLink href="/">Bills</BackLink>
      <Title vt={billTitle(id)} title={name} />
      <BillSkeleton />
    </Page>
  );
}

function useCachedSummary(id: string): SessionSummary | undefined {
  const qc = useQueryClient();
  for (const [, data] of qc.getQueriesData<{ sessions: SessionSummary[] }>({ queryKey: ['my-sessions'] })) {
    const s = data?.sessions.find((x) => x.sessionId === id);
    if (s) return s;
  }
  return undefined;
}

// Guests still picking get "What did you have?"; deleted bills say so.
function headedByVenue(s: SessionSummary): boolean {
  if (s.status === 'abandoned') return false;
  if (s.role === 'lead') return true;
  return !(s.status === 'claiming' && s.myPaymentStatus !== 'succeeded');
}
