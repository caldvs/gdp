'use client';

/**
 * The guest's side: claim what you had (Pick, built on ./claim's list),
 * then see where things stand until the lead closes the bill
 * (GuestTable). Pay lives in ./pay.
 */
import { useMemo } from 'react';
import { useMe } from '@gdp/core/api/hooks/useMe';
import type { components } from '@gdp/core/api';
import { formatGBP } from '@gdp/core/lib/money';
import { ledger } from '@gdp/core/lib/ledger';
import { itemStatuses as coreItemStatuses, type ItemStatus } from '@gdp/core/lib/leftovers';
import { extrasRate as billExtrasRate, projectFeePence, projectOwedPence, projectSubtotalPence, sharePence, splitPricePence } from '@gdp/core/lib/owed';
import {
  ActionBar, AvatarStack, BackButton, BackLink, Badge, Box, Button, Notice, Page, Pulse, Row, Section, Steps, Title, TotalLine, Totals, firstName,
} from '@/components/ui';
import { BillTools } from '@/components/BillTools';
import { billTitle } from '@/components/PageTransition';
import { ClaimList } from './claim';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];
type Share = NonNullable<Session['shares']>[number];


export type { ItemStatus } from '@gdp/core/lib/leftovers';
/** Every bill line in bill order with who has it (see core's itemStatuses). */
export function itemStatuses(s: Session, b: Bill, meUserId: string): ItemStatus[] {
  return coreItemStatuses(s, b, meUserId, (p) => firstName(p?.displayName));
}

/** A read-only bill line: open (nobody's yet), someone else's, or yours. */
export function ItemLine({ st }: { st: ItemStatus }) {
  const { item, left, mine, who, share } = st;
  const open = left > 0;
  const name = item.quantity > 1 ? `${item.name} × ${item.quantity}` : item.name;
  const seats = share ? Math.max(0, share.ways - share.userIds.length) : 0;
  // A longer line can have a split and units still to claim.
  const units = share?.units ?? 1;
  const sub = share
    ? [`${units > 1 ? `${units} shared` : 'Shared'} ${share.ways} ways`, seats ? `${seats} open` : null, item.quantity > 1 && open ? `${left} left` : null].filter(Boolean).join(' · ')
    : open && who.length > 0 ? `${left} left` : undefined;
  const price = share && !(item.quantity > 1 && open)
    ? formatGBP(sharePence(splitPricePence(item, share), share.userIds, share.ways, ''))
    : formatGBP(item.unitPricePence * (mine > 0 && !share ? mine : open ? left : item.quantity));
  return <Row title={name} sub={sub} end={price} muted={!open && mine === 0} lead={who.length > 0 ? <AvatarStack names={who} /> : undefined} />;
}
/** A guest who joined with just a name (#183): no Bills to go back to. */
export const useIsGuest = () => !!useMe().data?.guestSessionId;
export const owedFor = (s: Session, b: Bill, p: Participant) => p.owedPence ?? projectOwedPence(s, b, p.userId);

/* ============================ pick ============================ */

export function GuestPick({ s, b, meUserId, onBack }: { s: Session; b: Bill; meUserId: string; /** Set once they've paid (#121): back to their bill. */ onBack?: () => void }) {
  const me = s.participants.find((p) => p.userId === meUserId);
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = firstName(host?.displayName);
  const isGuest = useIsGuest();
  const subtotal = projectSubtotalPence(s, b, meUserId);
  const rate = billExtrasRate(b);
  // Plus their part of the lead's platform fee hold (#166).
  const fee = projectFeePence(s, b, meUserId);
  const owed = Math.round(subtotal * (1 + rate)) + fee;
  // #121: after paying, what's left to send is the difference.
  const l = me ? ledger(me, owed) : null;
  const paidSome = !!l && l.sentPence > 0;
  const due = l ? l.duePence : owed;

  return (
    <>
      <Page sub>
        {onBack ? (
          <BackButton onClick={onBack}>Your bill</BackButton>
        ) : (
          isGuest ? null : <BackLink href="/">Bills</BackLink>
        )}
        <Title title={paidSome ? 'What else did you have?' : 'What did you have?'} sub={`${b.venue?.name ? `${b.venue.name} · ` : ''}${hostFirst}’s bill`} aside={<BillTools sessionId={s.sessionId} billId={s.billId} showQr={!!s.joinCode && s.status === 'claiming'} />} />
        <ClaimList s={s} b={b} meUserId={meUserId} />
      </Page>
      <ActionBar stack>
        {owed > 0 ? (
          <div className="actionbar__total">
            <span className="muted">{paidSome ? `Paid ${formatGBP(l!.sentPence)} · still to pay` : totalLabel(rate > 0, fee > 0)}</span>
            <Pulse value={paidSome ? due : owed}><b data-testid="your-share">{formatGBP(paidSome ? due : owed)}</b></Pulse>
          </div>
        ) : null}
        {paidSome ? (
          <Button href={`/session/${s.sessionId}/pay`} disabled={due <= 0}>
            {due > 0 ? `Pay ${hostFirst} ${formatGBP(due)}` : 'Claim what else you had'}
          </Button>
        ) : (
          <Button href={`/session/${s.sessionId}/pay`} disabled={owed <= 0}>
            {owed > 0 ? 'Continue to payment' : 'Claim something to continue'}
          </Button>
        )}
      </ActionBar>
    </>
  );
}

/** "Your total incl. service and fee" */
export function totalLabel(service: boolean, fee: boolean): string {
  const parts = [service ? 'service' : null, fee ? 'fee' : null].filter(Boolean);
  return parts.length > 0 ? `Your total incl. ${parts.join(' and ')}` : 'Your total';
}

/** "Shared 2 ways with Priya · 1 open" */
export function splitSub(s: Session, share: Share, meUserId: string): string {
  const others = share.userIds.filter((u) => u !== meUserId).map((u) => firstName(s.participants.find((p) => p.userId === u)?.displayName));
  const seats = Math.max(0, share.ways - share.userIds.length);
  return [`Shared ${share.ways} ways${others.length ? ` with ${others.join(', ')}` : ''}`, seats ? `${seats} open` : null].filter(Boolean).join(' · ');
}

/* ============================ after paying (guest) ============================ */

export function GuestTable({ s, b, meUserId, onMore }: { s: Session; b: Bill; meUserId: string; /** #121: back to picking, to add something and top up. */ onMore?: () => void }) {
  const me = s.participants.find((p) => p.userId === meUserId);
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = firstName(host?.displayName);
  const isGuest = useIsGuest();
  const closed = s.status === 'settled';
  const statuses = useMemo(() => itemStatuses(s, b, meUserId), [s, b, meUserId]);
  const open = statuses.filter((x) => x.left > 0);

  const myOwed = me ? owedFor(s, b, me) : 0;
  const myFee = me ? projectFeePence(s, b, me.userId) : 0;
  const l = me ? ledger(me, myOwed) : null;
  const due = l?.duePence ?? 0;
  const waitingPence = l?.waiting.reduce((a, e) => a + e.amountPence, 0) ?? 0;
  const mustPay = due > 0;
  const sentPayments = l?.entries.filter((e) => e.status === 'succeeded' || (e.status === 'pending' && !!e.payerClaimedPaidAt)) ?? [];

  return (
    <>
      <Page sub>
        {isGuest ? null : <BackLink href="/">Bills</BackLink>}
        <Title vt={billTitle(s.sessionId)} title={b.venue?.name ?? `${hostFirst}’s bill`} sub={closed ? 'Bill closed' : `${hostFirst}’s bill`} aside={<BillTools sessionId={s.sessionId} billId={s.billId} showQr={!closed && !!s.joinCode} />} />
        {l?.settled ? (
          <PaidHero done host={hostFirst} pence={l.confirmedPence} />
        ) : mustPay ? (
          <Notice title={`You owe ${hostFirst} ${formatGBP(due)}${l && l.sentPence > 0 ? ' more' : ''}`} />
        ) : waitingPence > 0 ? (
          <PaidHero host={hostFirst} pence={waitingPence} />
        ) : null}

        {me && (me.claimedItemIds.length > 0 || me.sharedItemIds.length > 0) ? (
          <Section title="You had">
            <Box>
              {[...new Set(me.claimedItemIds)].map((id) => {
                const item = b.items.find((x) => x.itemId === id);
                if (!item) return null;
                const n = me.claimedItemIds.filter((x) => x === id).length;
                return <Row key={id} title={n > 1 ? `${item.name} × ${n}` : item.name} end={formatGBP(item.unitPricePence * n)} />;
              })}
              {me.sharedItemIds.map((id) => {
                const item = b.items.find((x) => x.itemId === id);
                const share = s.shares?.find((x) => x.itemId === id);
                if (!item || !share) return null;
                const units = share.units ?? 1;
                return <Row key={`${id}:split`} title={units > 1 ? `${item.name} × ${units}` : item.name} sub={splitSub(s, share, meUserId)} end={formatGBP(sharePence(splitPricePence(item, share), share.userIds, share.ways, meUserId))} />;
              })}
            </Box>
            <Totals>
              {myFee > 0 ? <TotalLine tone="mute" k="Platform fee" v={formatGBP(myFee)} /> : null}
              <TotalLine tone="total" k={totalLabel(b.serviceChargePence > 0 || b.taxPence > 0, myFee > 0)} v={formatGBP(myOwed)} />
            </Totals>
          </Section>
        ) : null}

        {sentPayments.length > 1 || (sentPayments.length === 1 && mustPay) ? (
          <Section title="Your payments">
            <Box>
              {sentPayments.map((e) => (
                <Row key={e.paymentId} title={formatGBP(e.amountPence)} end={e.status === 'succeeded' ? <Badge tone="ok">Confirmed</Badge> : <Badge>Waiting for {hostFirst}</Badge>} />
              ))}
            </Box>
          </Section>
        ) : null}

        {!closed && open.length > 0 ? (
          <Section title="Still to claim">
            <Box>{open.map((st) => <ItemLine key={st.item.itemId} st={st} />)}</Box>
          </Section>
        ) : null}

        {!closed ? <p className="small muted">{hostFirst} closes the bill once everyone’s paid.</p> : null}
      </Page>
      <ActionBar stack>
        {mustPay ? (
          <Button href={`/session/${s.sessionId}/pay`}>Pay {hostFirst} {formatGBP(due)}</Button>
        ) : null}
        {!mustPay && !l?.settled && waitingPence > 0 ? (
          <Button tone="secondary" href={`/session/${s.sessionId}/pay`}>See {hostFirst}’s bank details</Button>
        ) : null}
        {!closed && open.length > 0 && onMore ? (
          <Button tone={waitingPence > 0 && !mustPay ? 'text' : 'secondary'} onClick={onMore}>I had something else</Button>
        ) : mustPay || (waitingPence > 0 && !l?.settled) || isGuest ? null : (
          <Button tone={closed ? 'primary' : 'secondary'} href="/" replace>{closed ? 'Done' : 'Back to bills'}</Button>
        )}
      </ActionBar>
    </>
  );
}

/**
 * After *I've paid* (#184): the guest waits here until the lead confirms,
 * then it turns to *All square*. The session polls while it's open (3–5s),
 * so the change needs no reload.
 */
function PaidHero({ host, pence, done = false }: { host: string; pence: number; done?: boolean }) {
  return (
    <div className="paid-hero" role="status" aria-live="polite">
      {done ? (
        <span className="paid-hero__mark paid-hero__mark--ok" aria-hidden="true">
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.8} strokeLinecap="round" strokeLinejoin="round"><path className="paid-hero__tick" d="m5 12 5 5 9-10" /></svg>
        </span>
      ) : (
        <span className="paid-hero__mark" aria-hidden="true"><span className="paid-hero__ripple" /><span className="paid-hero__ripple paid-hero__ripple--2" /><span className="paid-hero__coin">£</span></span>
      )}
      <h2 className="paid-hero__h">{done ? 'All square' : `Waiting for ${host}…`}</h2>
      <p className="paid-hero__p">
        {done ? <>{host} got your <b>{formatGBP(pence)}</b>. Nothing more to do.</> : <>You’ve sent <b>{formatGBP(pence)}</b>. {host} will confirm when it lands in their account.</>}
      </p>
      <Steps steps={[
        { label: 'Picked your items', state: 'done' },
        { label: `Sent ${formatGBP(pence)} to ${host}`, state: 'done' },
        { label: done ? `${host} confirmed` : `${host} confirms`, state: done ? 'done' : 'busy' },
      ]} />
    </div>
  );
}
