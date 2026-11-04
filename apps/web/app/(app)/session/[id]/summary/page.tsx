'use client';

/**
 * The lead's bill summary (#131, board L6): a plain statement like the
 * emailed report. The bill, the platform fee, each person's items with
 * service and whether they've paid, what nobody claimed, payments with
 * times, and where the lead stands. Email this / Copy as text.
 */
import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useEmailReport, useSession } from '@gdp/core/api/hooks/useSession';
import { formatGBP } from '@gdp/core/lib/money';
import { billStatement, statementText, statusText, whenText, type StatementLine } from '@gdp/core/lib/statement';
import { copyText } from '@/lib/clipboard';
import { BackLink, Button, Centre, Notice, Page, Spinner, Title, firstName } from '@/components/ui';
import { useSpent } from '../lead';

export default function SummaryPage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const me = useMe();
  const bill = useBill(session.data?.billId, session.data?.pinnedBillVersion);
  const spent = useSpent(id);
  const report = useEmailReport(id);
  const [copied, setCopied] = useState<boolean | null>(null);

  const s = session.data;
  const b = bill.data;
  if (session.isError || bill.isError) {
    return (
      <Centre>
        <Notice tone="error" title="Couldn’t load the bill.">{session.error?.message ?? bill.error?.message}</Notice>
        <Button tone="secondary" href={`/session/${id}`}>Back to the bill</Button>
      </Centre>
    );
  }
  if (!s || !b || !me.data) return <Centre><Spinner /></Centre>;
  if (s.creatorUserId !== me.data.userId) {
    return (
      <Centre>
        <Notice title="Only the lead sees the full summary." />
        <Button tone="secondary" href={`/session/${id}`}>Back to the bill</Button>
      </Centre>
    );
  }

  const lead = s.participants.find((p) => p.userId === s.creatorUserId);
  const leadName = firstName(lead?.displayName, 'You');
  const st = billStatement(s, b, (p) => firstName(p.displayName, 'Guest'));
  const fee = spent.fee && !spent.fee.refundedAt ? spent.fee.amountPence : undefined;
  const venue = b.venue?.name ?? s.venue?.name;
  const title = venue ? `Bill summary: ${venue}` : 'Bill summary';
  const when = new Date(s.createdAt).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/London' });
  const own = st.people.find((p) => p.status === 'lead')?.totalPence ?? 0;

  const lines = (items: StatementLine[]) => items.map((i, k) => <tr key={k}><td>{i.label}</td><td className="n">{formatGBP(i.pence)}</td></tr>);

  return (
    <Page sub>
      <BackLink href={`/session/${id}`}>The bill</BackLink>
      <Title title={title} sub={<>{when}{s.joinCode ? <><br />Bill code {s.joinCode}</> : null}<br />Paid at the restaurant by {leadName}</>} />

      <div className="statement">
        <div>
          <h2>The bill</h2>
          <table>
            <tbody>
              <tr><td>Items</td><td className="n">{formatGBP(st.itemsPence)}</td></tr>
              {st.extrasPence > 0 ? <tr><td>Service</td><td className="n">{formatGBP(st.extrasPence)}</td></tr> : null}
              <tr className="t"><td>Bill total</td><td className="n">{formatGBP(st.totalPence)}</td></tr>
            </tbody>
          </table>
          {fee ? <p className="small muted" style={{ marginTop: 8 }}>Platform fee {formatGBP(fee)}, paid by {leadName}.</p> : null}
        </div>

        <div className="statement__people">
          <h2>Who had what</h2>
          {st.people.map((p) => (
            <table key={p.userId} aria-label={p.name}>
              <thead><tr><th>{p.status === 'lead' ? `${p.name} (you)` : p.name}</th><th className="n">{statusText(p.status)}</th></tr></thead>
              <tbody>
                {p.items.length === 0 ? <tr><td className="muted">Nothing claimed</td><td className="n" /></tr> : lines(p.items)}
                {p.extrasPence > 0 ? <tr><td>Service</td><td className="n">{formatGBP(p.extrasPence)}</td></tr> : null}
                <tr className="t"><td>Total</td><td className="n">{formatGBP(p.totalPence)}</td></tr>
              </tbody>
            </table>
          ))}
          {st.unclaimed.items.length > 0 ? (
            <table aria-label="Nobody claimed">
              <thead><tr><th>Nobody claimed</th><th className="n">Goes to {leadName}</th></tr></thead>
              <tbody>
                {lines(st.unclaimed.items)}
                {st.unclaimed.extrasPence > 0 ? <tr><td>Service</td><td className="n">{formatGBP(st.unclaimed.extrasPence)}</td></tr> : null}
                <tr className="t"><td>Total</td><td className="n">{formatGBP(st.unclaimed.totalPence)}</td></tr>
              </tbody>
            </table>
          ) : null}
        </div>

        <div>
          <h2>Payments to {leadName}</h2>
          <table>
            <thead><tr><th>From</th><th>When</th><th className="n">Amount</th></tr></thead>
            <tbody>
              {st.payments.map((p, k) => (
                <tr key={k}><td>{p.name}</td><td>{p.at ? whenText(p.at) : ''}{p.confirmed ? ', confirmed' : ''}</td><td className="n">{formatGBP(p.amountPence)}</td></tr>
              ))}
              {st.unpaid.map((u) => (
                <tr key={u.name}><td>{u.name}</td><td>Not paid</td><td className="n">{formatGBP(u.pence)}</td></tr>
              ))}
              <tr className="t"><td>Received</td><td /><td className="n">{formatGBP(st.receivedPence)}</td></tr>
              <tr className="t"><td>Outstanding</td><td /><td className="n">{formatGBP(st.outstandingPence)}</td></tr>
            </tbody>
          </table>
        </div>

        <div>
          <h2>{leadName}’s position</h2>
          <table>
            <tbody>
              <tr><td>Paid the restaurant</td><td className="n">{formatGBP(st.totalPence)}</td></tr>
              {fee ? <tr><td>Paid the platform fee</td><td className="n">{formatGBP(fee)}</td></tr> : null}
              <tr><td>Own share</td><td className="n">−{formatGBP(own)}</td></tr>
              {st.unclaimed.totalPence > 0 ? <tr><td>Nobody claimed</td><td className="n">−{formatGBP(st.unclaimed.totalPence)}</td></tr> : null}
              <tr className="t"><td>Owed by guests</td><td className="n">{formatGBP(st.owedByGuestsPence)}</td></tr>
            </tbody>
          </table>
        </div>

        <div className="tools">
          <Button tone="secondary" small onClick={() => report.mutate()} disabled={report.isPending || report.isSuccess} busy={report.isPending}>
            {report.isSuccess ? 'Emailed' : 'Email this'}
          </Button>
          <Button tone="secondary" small onClick={async () => setCopied(await copyText(statementText(st, { title, leadName, ...(fee ? { feePence: fee } : {}) })))}>
            {copied ? 'Copied' : 'Copy as text'}
          </Button>
        </div>
        {report.isError ? <Notice tone="error">{report.error.message}</Notice> : null}
        {copied === false ? <Notice tone="error">Couldn’t copy. Select the text instead.</Notice> : null}
      </div>
    </Page>
  );
}
