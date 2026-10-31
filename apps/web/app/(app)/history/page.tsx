'use client';

/** Every bill you've hosted or joined, newest first. */
import { useState } from 'react';
import { useMySessions, type SessionSummary } from '@gdp/core/api/hooks/useMySessions';
import { formatGBP } from '@gdp/core/lib/money';
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
        <Box>
          {list.map((s) => (
            <RowLink
              key={s.sessionId}
              href={`/session/${s.sessionId}`}
              tall
              title={s.venue?.name ?? (s.role === 'lead' ? 'Your bill' : 'A bill you joined')}
              sub={`${formatWhen(s.createdAt)} · ${s.role === 'lead' ? 'hosted' : 'joined'}${s.status === 'abandoned' ? ' · deleted' : ''}`}
              end={<Side s={s} />}
            />
          ))}
        </Box>
      ) : null}
    </Page>
  );
}

function Side({ s }: { s: SessionSummary }) {
  if (s.role === 'lead') return <span className="muted">{s.status === 'settled' ? 'Closed' : s.status === 'abandoned' ? '' : 'Open'}</span>;
  if (s.myPaymentStatus === 'succeeded' && s.myOwedPence !== undefined) return <Badge tone="ok">Paid {formatGBP(s.myOwedPence)}</Badge>;
  if (s.myOwedPence !== undefined) return <span>{formatGBP(s.myOwedPence)}</span>;
  return null;
}
