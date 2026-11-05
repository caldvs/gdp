'use client';

/** Every bill you've hosted or joined, newest first. */
import { useState } from 'react';
import { useMySessions, type SessionSummary } from '@gdp/core/api/hooks/useMySessions';
import { formatGBP } from '@gdp/core/lib/money';
import { billTitle } from '@/components/PageTransition';
import { BackLink, Badge, Box, Notice, Page, RowLink, Spinner, Title, formatWhen } from '@/components/ui';

type Filter = 'all' | 'hosted' | 'joined';

export default function HistoryPage() {
  const sessions = useMySessions(100);
  const [filter, setFilter] = useState<Filter>('all');
  const list = (sessions.data?.sessions ?? []).filter((s) => filter === 'all' || (filter === 'hosted' ? s.role === 'lead' : s.role !== 'lead'));

  return (
    <Page sub>
      <BackLink href="/account">Account</BackLink>
      <Title
        title="History"
        aside={
          <select className="select select--sm" aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
            <option value="all">All</option>
            <option value="hosted">Hosted</option>
            <option value="joined">Joined</option>
          </select>
        }
      />
      {sessions.isPending ? <Spinner /> : null}
      {sessions.isError ? <Notice tone="error">{sessions.error.message}</Notice> : null}
      {sessions.isSuccess && list.length === 0 ? <p className="muted">Nothing here yet.</p> : null}
      {list.length > 0 ? (
        <Box list label="Bills">
          {list.map((s) => (
            <RowLink
              key={s.sessionId}
              href={`/session/${s.sessionId}`}
              vt={billTitle(s.sessionId)}
              tall
              title={s.venue?.name ?? (s.role === 'lead' ? 'Your bill' : 'A bill you joined')}
              sub={sub(s)}
              end={<Side s={s} />}
            />
          ))}
        </Box>
      ) : null}
    </Page>
  );
}

const isOpen = (s: SessionSummary) => s.status === 'setup' || s.status === 'claiming' || s.status === 'paying';

/** When · hosted or joined · open or deleted; a guest's also names the whole bill. */
function sub(s: SessionSummary): string {
  const parts = [formatWhen(s.createdAt), s.role === 'lead' ? 'hosted' : 'joined'];
  if (s.status === 'abandoned') parts.push('deleted');
  else {
    if (s.role === 'lead' && isOpen(s)) parts.push('open');
    if (s.role !== 'lead' && s.billTotalPence !== undefined) parts.push(`${formatGBP(s.billTotalPence)} bill`);
  }
  return parts.join(' · ');
}

/** The host sees the bill's total; a guest sees their share, ticked once paid. */
function Side({ s }: { s: SessionSummary }) {
  if (s.status === 'abandoned') return null;
  if (s.role === 'lead') return s.billTotalPence !== undefined ? <span>{formatGBP(s.billTotalPence)}</span> : null;
  const share = s.mySharePence ?? s.myOwedPence;
  if (share === undefined) return null;
  if (s.myPaymentStatus === 'succeeded') return <Badge tone="ok">Paid {formatGBP(share)}</Badge>;
  return <span>{formatGBP(share)}</span>;
}
