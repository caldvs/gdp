'use client';

/**
 * #217 L8: the platform fee on a settled bill, and how it was worked out.
 * Since #228 the £1 hold is always released and the saved card is charged
 * the round-ups of the guests the lead marked received (`feeBreakdown`, as
 * the API does it), so the lead pays nothing towards it. L8.1: guests still
 * owing don't count. L8.2: nobody joined. A free credit: just that.
 * Numbers come from `billStatement`, as on L7, *The whole bill* and the email.
 */
import { useParams } from 'next/navigation';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useSession } from '@gdp/core/api/hooks/useSession';
import { cardLabel } from '@gdp/core/api/hooks/useTableFee';
import { formatGBP } from '@gdp/core/lib/money';
import { billStatement, feeBreakdown } from '@gdp/core/lib/statement';
import { BackLink, Box, Button, Centre, Notice, Page, Spinner, Title, firstName } from '@/components/ui';
import { useSpent } from '../lead';

/** "Sam", "Sam or Tom", "Sam, Ana or Tom". */
const orList = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;

export default function FeePage() {
  const { id } = useParams<{ id: string }>();
  const session = useSession(id);
  const me = useMe();
  const bill = useBill(session.data?.billId, session.data?.pinnedBillVersion);
  const s = session.data;
  const first = useSpent(id, !!s);
  const f = first.fee;
  // Settle answers once the hold is adjusted; a stale read polls until then.
  const adjusting = s?.status === 'settled' && f?.kind === 'hold' && !f.chargeStatus && !f.capturedAt && !f.releasedAt && !f.refundedAt;
  const spent = useSpent(id, !!s, { poll: adjusting });
  const back = <BackLink href={`/session/${id}`}>The bill</BackLink>;

  if (session.isError || bill.isError) {
    return (
      <Centre>
        <Notice tone="error" title="Couldn’t load the bill.">{session.error?.message ?? bill.error?.message}</Notice>
        <Button tone="secondary" href={`/session/${id}`}>Back to the bill</Button>
      </Centre>
    );
  }
  const b = bill.data;
  if (!s || !b || !me.data || spent.loading) return <Centre><Spinner /></Centre>;
  if (s.creatorUserId !== me.data.userId) {
    return (
      <Centre>
        <Notice title="Only the lead sees the platform fee." />
        <Button tone="secondary" href={`/session/${id}`}>Back to the bill</Button>
      </Centre>
    );
  }

  const fee = spent.fee;
  if (!fee) {
    return (
      <Page sub>
        {back}
        <Title title="Platform fee" sub={spent.credit ? (spent.credit.returnedAt ? 'Free credit · given back, nobody joined' : 'Free credit') : 'None on this bill'} />
      </Page>
    );
  }
  if (adjusting) {
    return (
      <Page sub>
        {back}
        <div className="box pay-wait pay-wait--paying" role="status" aria-live="polite">
          <h1 className="pay-wait__title">Adjusting your {formatGBP(fee.amountPence)} hold</h1>
          <Spinner />
        </div>
      </Page>
    );
  }

  const hold = formatGBP(fee.amountPence);
  const st = billStatement(s, b, (p) => firstName(p.displayName, 'Guest'));
  const fb = feeBreakdown(st);
  const guests = st.people.filter((p) => p.status !== 'lead');
  // L8.2: nobody joined. The hold was released and nothing worked out.
  if (guests.length === 0 || fee.kind !== 'hold') {
    return (
      <Page sub>
        {back}
        <Title title="Platform fee" sub={fee.kind === 'hold' ? `Your ${hold} hold is released` : fee.refundedAt ? 'Refunded' : formatGBP(fee.amountPence)} />
        {fee.kind === 'hold' ? <p className="muted">Nobody joined, so there’s no fee.</p> : null}
      </Page>
    );
  }

  const charged = fee.chargeStatus ? (fee.chargePence ?? 0) : (fee.capturedPence ?? 0);
  const headline =
    fee.chargeStatus === 'charged' ? `${formatGBP(charged)} charged to your card`
    : fee.chargeStatus === 'needs_confirming' ? `${formatGBP(charged)} to confirm`
    : fee.capturedAt ? `${formatGBP(charged)} taken from your hold`
    : 'Nothing charged';
  const sub = fee.capturedAt && !fee.chargeStatus ? 'The rest of your hold is released' : `Your ${hold} hold is released`;
  const later = fb.later.map((p) => p.name);

  return (
    <Page sub>
      {back}
      <Title title="Platform fee" sub={<><b data-testid="fee-headline">{headline}</b> · {sub}</>} />
      {fee.chargeStatus === 'needs_confirming' ? (
        <Button href={`/fee-charge/${fee.billId}`}>{`Confirm ${formatGBP(charged)}`}</Button>
      ) : null}
      <div className="statement">
        <div>
          <h2>How it was worked out</h2>
          <table aria-label="Round-ups">
            <thead><tr><th>Guest</th><th className="n">Share</th><th className="n">Rounded</th><th className="n">Round-up</th></tr></thead>
            <tbody>
              {guests.map((p) => {
                const counts = fb.counted.includes(p);
                return (
                  <tr key={p.userId}>
                    <td>{p.name}</td>
                    <td className="n">{formatGBP(p.totalPence - p.feePence)}</td>
                    <td className="n">{formatGBP(p.totalPence)}</td>
                    <td className="n">{counts ? formatGBP(p.feePence) : p.feePence > 0 ? 'Not yet' : formatGBP(0)}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr><td colSpan={3}>Round-ups you got</td><td className="n">{formatGBP(fb.roundUpsPence)}</td></tr>
              <tr><td colSpan={3}>Platform fee</td><td className="n">{formatGBP(charged)}</td></tr>
              <tr><td colSpan={3}><b>You paid towards it</b></td><td className="n"><b>{formatGBP(Math.max(0, charged - fb.roundUpsPence))}</b></td></tr>
            </tfoot>
          </table>
        </div>
      </div>
      <p className="muted">Your guests covered it by rounding up.{fb.roundUpsPence > 0 && fb.feePence === 0 ? ' Under 30p, nothing is charged.' : ''}</p>
      {later.length > 0 ? <p className="muted">If {orList(later)} {later.length === 1 ? 'pays' : 'pay'} later, the money is all yours. Nothing more is charged.</p> : null}
      {charged > 0 && fee.chargeStatus ? (
        <Box>
          <p className="small muted" style={{ margin: 0 }}>{spent.card ? `${cardLabel(spent.card)} · ` : ''}On your statement as PAYMEBACK.DEV</p>
        </Box>
      ) : null}
    </Page>
  );
}
