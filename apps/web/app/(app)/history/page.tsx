'use client';

/** Every bill you've hosted or joined, newest first. */
import { useState } from 'react';
import { useMySessions, type SessionSummary } from '@gdp/core/api/hooks/useMySessions';
import { formatGBP } from '@gdp/core/lib/money';
import { Back, Backdrop, Centre, Chevron, Fab, List, Notice, Paid, Price, Row, RowBody, Screen, Sheet, Spin, TopBar } from '@/components/glass';

type Filter = 'all' | 'hosted' | 'joined';

export default function HistoryPage() {
  const sessions = useMySessions(100);
  const [filter, setFilter] = useState<Filter>('all');
  const list = (sessions.data?.sessions ?? []).filter((s) => filter === 'all' || (filter === 'hosted' ? s.role === 'lead' : s.role !== 'lead'));

  return (
    <Screen>
      <Backdrop tone="deep" />
      <TopBar left={<Fab href="/account" label="Back" icon={<Back />} replace />} title="History" />
      <Sheet size="tall" head={
        <div className="g-sheet__head" style={{ paddingBottom: 4 }}>
          <div role="tablist" style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
            {(['all', 'hosted', 'joined'] as Filter[]).map((f) => (
              <button key={f} type="button" role="tab" aria-selected={filter === f} className={`g-mini-btn${filter === f ? ' g-mini-btn--solid' : ''}`} onClick={() => setFilter(f)}>
                {f === 'all' ? 'All' : f === 'hosted' ? 'Hosted' : 'Joined'}
              </button>
            ))}
          </div>
        </div>
      }>
        {sessions.isPending ? <Centre><Spin /></Centre> : null}
        {sessions.isError ? <Notice error>{sessions.error.message}</Notice> : null}
        {sessions.isSuccess && list.length === 0 ? <p className="g-foot-note" style={{ padding: 24 }}>Nothing here yet</p> : null}
        {list.length > 0 ? (
          <List>
            {list.map((s) => (
              <Row key={s.sessionId} href={`/session/${s.sessionId}`}>
                <RowBody name={s.venue?.name ?? (s.role === 'lead' ? 'Your bill' : 'A bill you joined')} sub={`${when(s.createdAt)} · ${s.role === 'lead' ? 'hosted' : 'joined'}${s.status === 'abandoned' ? ' · binned' : ''}`} />
                <Side s={s} />
                <Chevron />
              </Row>
            ))}
          </List>
        ) : null}
      </Sheet>
    </Screen>
  );
}

function Side({ s }: { s: SessionSummary }) {
  if (s.role === 'lead') return <Price mute>{s.status === 'settled' ? 'closed' : s.status === 'abandoned' ? '' : 'open'}</Price>;
  if (s.myPaymentStatus === 'succeeded' && s.myOwedPence !== undefined) return <Paid>{formatGBP(s.myOwedPence)}</Paid>;
  if (s.myOwedPence !== undefined) return <Price mute>{formatGBP(s.myOwedPence)}</Price>;
  return null;
}

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const y = new Date(today); y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
