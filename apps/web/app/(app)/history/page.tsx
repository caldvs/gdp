'use client';

/** Every bill you've hosted or joined, newest first. */
import { useState } from 'react';
import { useMySessions, type SessionSummary } from '@gdp/core/api/hooks/useMySessions';
import { formatGBP } from '@gdp/core/lib/money';
import { billTitle } from '@/components/PageTransition';
import { BackLink, Badge, Box, Notice, Page, RowLink, Section, Spinner, Title, formatWhen } from '@/components/ui';

type Filter = 'all' | 'hosted' | 'joined';

const FILTERS: { key: Filter; label: string }[] = [{ key: 'all', label: 'All' }, { key: 'hosted', label: 'Hosted' }, { key: 'joined', label: 'Joined' }];

/** M3 Every bill (#224): grouped by month, newest first, with filters. */
export default function HistoryPage() {
  const sessions = useMySessions(100);
  const [filter, setFilter] = useState<Filter>('all');
  const list = (sessions.data?.sessions ?? []).filter((s) => filter === 'all' || (filter === 'hosted' ? s.role === 'lead' : s.role !== 'lead'));
  const months: { label: string; bills: SessionSummary[] }[] = [];
  for (const s of list) {
    const label = new Date(s.createdAt).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'Europe/London' });
    const last = months[months.length - 1];
    if (last?.label === label) last.bills.push(s);
    else months.push({ label, bills: [s] });
  }

  return (
    <Page sub>
      <BackLink href="/account">Account</BackLink>
      <Title title="Every bill" />
      <div className="filters" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" className="filter" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>
        ))}
      </div>
      {sessions.isPending ? <Spinner /> : null}
      {sessions.isError ? <Notice tone="error">{sessions.error.message}</Notice> : null}
      {sessions.isSuccess && list.length === 0 ? <p className="muted">Nothing here yet.</p> : null}
      {months.map((m) => (
        <Section key={m.label} title={m.label}>
          <Box list label={m.label}>
            {m.bills.map((s) => (
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
        </Section>
      ))}
    </Page>
  );
}


/** When · hosted or joined · where it stands ("Settled", "Open · 2 to pay"). */
function sub(s: SessionSummary): string {
  const parts = [formatWhen(s.createdAt), s.role === 'lead' ? 'hosted' : 'joined'];
  if (s.status === 'abandoned') parts.push('deleted');
  else if (s.status === 'settled') parts.push('Settled');
  else if (s.role === 'lead') parts.push(s.toPayCount ? `Open · ${s.toPayCount} to pay` : 'Open');
  if (s.status !== 'abandoned' && s.role !== 'lead' && s.billTotalPence !== undefined) parts.push(`${formatGBP(s.billTotalPence)} bill`);
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
