'use client';

/**
 * G5 (#220): the bill from the link in a guest's text, read-only and live.
 * No sign-in: the token is the key. Who had what, who's paid, the guest's
 * own share marked, and *Nobody claimed* on its own. Never bank details
 * (ADR-0002): a guest who still owes is sent to the pay page only on a
 * device that already has the lead's details from the QR; anywhere else
 * they're told to pay the lead.
 */
import { useParams } from 'next/navigation';
import { useBillLink, type BillLinkView } from '@gdp/core/api/hooks/useTexts';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSessionPayout } from '@gdp/core/lib/useSessionPayout';
import { formatGBP } from '@gdp/core/lib/money';
import { ApiError } from '@gdp/core/api';
import { Badge, Button, Centre, Notice, Page, Spinner, Title, firstName } from '@/components/ui';

type Diner = BillLinkView['diners'][number];

function status(d: Diner, lead: string): string {
  if (d.isLead) return `${lead}’s share`;
  if (d.paid.kind === 'paid') return 'Paid';
  if (d.paid.kind === 'says_paid') return 'Says paid';
  return 'Not paid';
}

export default function BillLinkPage() {
  const { token } = useParams<{ token: string }>();
  const link = useBillLink(token);
  // Read what the shell asked: asking again on mount loops a signed-out visitor (#183).
  const me = useMe({ refetchOnMount: false });
  const payout = useSessionPayout(link.data?.sessionId);

  if (link.isError) {
    const gone = link.error instanceof ApiError && link.error.status === 404;
    return (
      <Centre>
        <Notice tone={gone ? 'info' : 'error'} title={gone ? 'This link has expired.' : 'Couldn’t load the bill.'}>
          {gone ? 'Bill links work for 30 days.' : link.error.message}
        </Notice>
      </Centre>
    );
  }
  const v = link.data;
  if (!v) return <Centre><Spinner /></Centre>;

  const lead = firstName(v.leadName);
  const you = v.diners.find((d) => d.isYou);
  const owes = you && !you.isLead && you.paid.kind === 'not_paid' && you.totalPence > 0;
  // Bank details only where the QR already put them, and only on the pay page.
  const canPayHere = !!payout.data && !!me.data;
  const date = new Date(v.dateISO).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' });
  const until = new Date(v.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' });

  return (
    <Page sub>
      <Title
        title={v.venueName ?? `${lead}’s bill`}
        sub={<>{v.settled ? <><Badge tone="ok">Settled</Badge> </> : null}{date} · {formatGBP(v.billTotalPence)}</>}
      />

      {you && !you.isLead ? (
        owes ? (
          <Notice title={`You owe ${lead} ${formatGBP(you.totalPence)}`}>
            {canPayHere ? null : `Pay ${lead} directly. ${lead} marks it received.`}
          </Notice>
        ) : you.paid.kind === 'paid' ? (
          <Notice tone="ok" title={`${lead} got your ${formatGBP(you.paid.amountPence ?? you.totalPence)}`} />
        ) : you.paid.kind === 'says_paid' ? (
          <Notice title={`Waiting for ${lead} to mark it received`} />
        ) : null
      ) : null}
      {owes && canPayHere ? <Button href={`/session/${v.sessionId}/pay`}>Pay {lead}</Button> : null}

      <div className="statement">
        <div className="statement__people">
          <h2>Who had what</h2>
          {v.diners.map((d, k) => (
            <table key={k} aria-label={d.isYou ? 'You' : d.displayName} className={d.isYou ? 'statement--you' : undefined}>
              <thead><tr><th>{d.isYou ? `${d.displayName} (you)` : d.displayName}</th><th className="n">{status(d, lead)}</th></tr></thead>
              <tbody>
                {d.lines.length === 0 ? <tr><td className="muted">Nothing claimed</td><td className="n" /></tr> : d.lines.map((l, i) => (
                  <tr key={i}><td>{l.name}{l.detail ? <span className="muted"> · {l.detail}</span> : null}</td><td className="n">{formatGBP(l.pence)}</td></tr>
                ))}
                {d.extrasPence > 0 ? <tr><td>Service</td><td className="n">{formatGBP(d.extrasPence)}</td></tr> : null}
                {d.discountPence > 0 ? <tr><td>Discount</td><td className="n">−{formatGBP(d.discountPence)}</td></tr> : null}
                {d.feePence > 0 ? <tr><td>Round-up</td><td className="n">{formatGBP(d.feePence)}</td></tr> : null}
                <tr className="t"><td>Total</td><td className="n">{formatGBP(d.totalPence)}</td></tr>
              </tbody>
            </table>
          ))}
          {v.unclaimed.length > 0 ? (
            <table aria-label="Nobody claimed">
              <thead><tr><th>Nobody claimed</th><th className="n">{v.settled ? `${lead} covered it` : `Goes on ${lead}`}</th></tr></thead>
              <tbody>
                {v.unclaimed.map((l, i) => <tr key={i}><td>{l.name}{l.detail ? <span className="muted"> · {l.detail}</span> : null}</td><td className="n">{formatGBP(l.pence)}</td></tr>)}
                <tr className="t"><td>With service</td><td className="n">{formatGBP(v.unclaimedPence)}</td></tr>
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
      <p className="small muted">This link works until {until}.</p>
    </Page>
  );
}
