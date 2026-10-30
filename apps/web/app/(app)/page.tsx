'use client';

import { useMySessions, type SessionSummary } from '@gdp/core/api/hooks/useMySessions';
import { formatGBP } from '@gdp/core/lib/money';
import { useScanner } from '@/components/Scanner';
import { ActionBar, Badge, Box, Button, Notice, Page, RowLink, Section, Spinner, Title, formatWhen } from '@/components/ui';

const isOpen = (s: SessionSummary) => s.status === 'claiming' || s.status === 'paying' || s.status === 'setup';

/** Home: your bills, open first, with Scan and Join at the bottom. */
export default function BillsPage() {
  const sessions = useMySessions(50);
  const scanner = useScanner();
  if (scanner.reading) return <>{scanner.inputs}{scanner.reading}</>;

  const all = sessions.data?.sessions ?? [];
  const open = all.filter(isOpen);
  const past = all.filter((s) => !isOpen(s));

  return (
    <>
      {scanner.inputs}
      <Page>
        <Title title="Bills" />
        {scanner.error ? <Notice tone="error" title={scanner.error.title}>{scanner.error.body}</Notice> : null}
        {sessions.isPending ? <Spinner /> : null}
        {sessions.isError ? <Notice tone="error" title="Couldn’t load your bills.">{sessions.error.message}</Notice> : null}

        {open.length > 0 ? (
          <Section title="Open">
            {open.map((s) => (
              <RowLink key={s.sessionId} href={`/session/${s.sessionId}`} card strong title={venue(s)} sub={openSub(s)} end={openBadge(s)} />
            ))}
          </Section>
        ) : null}

        {past.length > 0 ? (
          <Section title="Past">
            <Box>
              {past.map((s) => (
                <RowLink key={s.sessionId} href={`/session/${s.sessionId}`} tall title={venue(s)} sub={pastSub(s)} end={pastEnd(s)} />
              ))}
            </Box>
          </Section>
        ) : null}

        {sessions.isSuccess && all.length === 0 ? (
          <p className="muted">No bills yet. Scan one to split it with the table.</p>
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
function pastSub(s: SessionSummary): string {
  const when = formatWhen(s.createdAt);
  if (s.status === 'abandoned') return `${when} · ${s.role === 'lead' ? 'you deleted it' : 'the host deleted it'}`;
  return `${when} · ${s.role === 'lead' ? 'you hosted' : 'you joined'}`;
}
function pastEnd(s: SessionSummary) {
  if (s.status === 'abandoned') return <Badge>Deleted</Badge>;
  return s.myOwedPence !== undefined && s.role !== 'lead' ? formatGBP(s.myOwedPence) : undefined;
}
function openSub(s: SessionSummary): string {
  const when = formatWhen(s.createdAt);
  if (s.role !== 'lead') return `${when} · you joined`;
  return s.status === 'setup' ? `${when} · not shared yet` : `${when} · you’re collecting`;
}
function openBadge(s: SessionSummary) {
  if (s.role !== 'lead') {
    if (s.myPaymentStatus === 'succeeded') return <Badge tone="ok">Paid</Badge>;
    return s.myOwedPence !== undefined ? <Badge tone="warn">You owe {formatGBP(s.myOwedPence)}</Badge> : undefined;
  }
  return undefined;
}
