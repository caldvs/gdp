'use client';

import type { ReactNode } from 'react';
import { useMySessions, type SessionSummary } from '@gdp/core/api/hooks/useMySessions';
import { formatGBP } from '@gdp/core/lib/money';
import { useScanner } from '@/components/Scanner';
import { PendingReadRow } from '@/components/PendingRead';
import { billTitle } from '@/components/PageTransition';
import { ActionBar, Badge, Box, Button, CardList, Notice, Page, Row, RowLink, Section, Spinner, Title, formatWhen } from '@/components/ui';

const isOpen = (s: SessionSummary) => s.status === 'claiming' || s.status === 'paying' || s.status === 'setup';

/** Home: your bills, open first, with Scan and Join at the bottom. */
export default function BillsPage() {
  const sessions = useMySessions(50);
  const scanner = useScanner();
  if (scanner.screen) return <>{scanner.inputs}{scanner.screen}</>;

  const all = sessions.data?.sessions ?? [];
  const open = all.filter(isOpen);
  const past = all.filter((s) => !isOpen(s));

  return (
    <>
      {scanner.inputs}
      <Page>
        <Title title="Bills" />
        {scanner.error ? <Notice tone="error" title={scanner.error.title}>{scanner.error.body}</Notice> : null}
        <PendingReadRow sessionBillIds={sessions.data?.sessions.map((s) => s.billId)} />
        {sessions.isPending ? <Spinner /> : null}
        {sessions.isError ? <Notice tone="error" title="Couldn’t load your bills.">{sessions.error.message}</Notice> : null}

        {open.length > 0 ? (
          <Section title="Open">
            <CardList>
              {open.map((s) => (
                <RowLink key={s.sessionId} href={`/session/${s.sessionId}`} vt={billTitle(s.sessionId)} card strong title={venue(s)} sub={openSub(s)} end={openEnd(s)} />
              ))}
            </CardList>
          </Section>
        ) : null}

        {past.length > 0 ? (
          <Section title="Settled">
            <Box list>
              {past.map((s) => (
                <RowLink key={s.sessionId} href={`/session/${s.sessionId}`} vt={billTitle(s.sessionId)} tall title={venue(s)} sub={pastSub(s)} end={pastEnd(s)} />
              ))}
            </Box>
          </Section>
        ) : null}

        {sessions.isSuccess && all.length === 0 ? (
          <>
            {/* The shape of a bill card, to show where bills will appear (7 Nov).
                Shapes, not text: faded text would fail contrast. */}
            <div className="empty-demo row row--card" aria-hidden="true">
              <span className="empty-demo__lines"><span className="skel" style={{ width: '62%' }} /><span className="skel" style={{ width: '40%' }} /></span>
              <span className="skel empty-demo__badge" />
            </div>
            <p className="muted">No bills yet. Scan one to split it with the table.</p>
          </>
        ) : null}
      </Page>
      <ActionBar>
        <Button tone="secondary" href="/join">Join a bill</Button>
        <Button grow onClick={scanner.openCamera}>Scan a bill</Button>
      </ActionBar>
    </>
  );
}

function venue(s: SessionSummary): string {
  return s.venue?.name ?? (s.role === 'lead' ? 'Your bill' : 'A bill you joined');
}
/** What the caller had: their share now, or what was locked in on older bills. */
function shareOf(s: SessionSummary): number | undefined {
  return s.mySharePence ?? s.myOwedPence;
}
/** A guest's row names the whole bill; the host's shows it on the right. */
function billOf(s: SessionSummary): string {
  return s.role !== 'lead' && s.billTotalPence !== undefined ? ` · ${formatGBP(s.billTotalPence)} bill` : '';
}
function pastSub(s: SessionSummary): string {
  const when = formatWhen(s.createdAt);
  if (s.status === 'abandoned') return `${when} · ${s.role === 'lead' ? 'you deleted it' : 'the host deleted it'}`;
  return `${when} · ${s.role === 'lead' ? 'you paid' : 'you joined'}${billOf(s)}`;
}
/** L1 (#223): the money, then where it stands, one above the other. */
function endOf(pence: number | undefined, state: ReactNode) {
  return <span className="bill-end">{pence !== undefined ? <b>{formatGBP(pence)}</b> : null}{state}</span>;
}
function pastEnd(s: SessionSummary) {
  if (s.status === 'abandoned') return <Badge>Deleted</Badge>;
  return endOf(s.role === 'lead' ? s.billTotalPence : shareOf(s), <Badge tone="ok">Settled</Badge>);
}
function openSub(s: SessionSummary): string {
  const when = formatWhen(s.createdAt);
  if (s.role !== 'lead') return `${when} · you joined${billOf(s)}`;
  if (s.status === 'setup') return `${when} · not shared yet`;
  return s.peopleCount !== undefined ? `${when} · ${s.peopleCount} ${s.peopleCount === 1 ? 'person' : 'people'}` : when;
}
function openEnd(s: SessionSummary) {
  if (s.role === 'lead') {
    const toPay = s.toPayCount ?? 0;
    return endOf(s.billTotalPence, s.status === 'setup' ? null : <span className="bill-end__sub">{toPay > 0 ? `${toPay} to pay` : 'All paid'}</span>);
  }
  if (s.myPaymentStatus === 'succeeded') return <Badge tone="ok">Paid</Badge>;
  const owe = shareOf(s);
  return owe ? <Badge tone="warn">You owe {formatGBP(owe)}</Badge> : undefined;
}
