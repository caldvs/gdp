'use client';

/**
 * The guest's side: claim what you had (Pick, built on ./claim's list),
 * then see where things stand until the lead closes the bill
 * (GuestTable). Pay lives in ./pay.
 */
import { Comments } from '@/components/Comments';
import { ProofOfPayment, useProofOffered } from '@/components/Proof';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMe } from '@gdp/core/api/hooks/useMe';
import type { components } from '@gdp/core/api';
import { formatGBP } from '@gdp/core/lib/money';
import { ledger } from '@gdp/core/lib/ledger';
import { allClaimed, itemStatuses as coreItemStatuses, openedEarly, paymentsOpen, unclaimedLines, type ItemStatus } from '@gdp/core/lib/leftovers';
import { claimRows, openPence } from '@gdp/core/lib/claimRows';
import { extrasRate as billExtrasRate, projectFeePence, projectOwedPence, projectSubtotalPence, sharePence, splitPricePence } from '@gdp/core/lib/owed';
import {
  ActionBar, AvatarStack, BackButton, BackLink, Badge, Box, Button, Notice, Page, Pulse, Receipt, ReceiptLine, Row, Section, Title, TotalLine, Totals, firstName,
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
  // Plus their round-up to the next whole pound.
  const fee = projectFeePence(s, b, meUserId);
  const owed = Math.round(subtotal * (1 + rate)) + fee;
  // #121: after paying, what's left to send is the difference.
  const l = me ? ledger(me, owed) : null;
  const paidSome = !!l && l.sentPence > 0;
  const due = l ? l.duePence : owed;
  // #216: nobody sees what they owe, or pays, until every line is claimed
  // (or the lead opens payments early). G2 here; *I've claimed mine* → G2.2
  // waiting; *See what you owe* → G2.3.
  const open = paymentsOpen(s, b);
  const toClaim = unclaimedLines(s, b).length;
  const [view, setView] = useState<'pick' | 'waiting' | 'owed'>('pick');
  if (!paidSome && view === 'owed' && open) {
    return <WhatYouOwe s={s} b={b} meUserId={meUserId} owed={owed} onChange={() => setView('pick')} />;
  }
  if (!paidSome && view !== 'pick') {
    return <WaitingForTable s={s} b={b} meUserId={meUserId} onBack={() => setView('pick')} onSee={() => setView('owed')} />;
  }
  const holding = !open && !paidSome;

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
        {holding ? (
          <>
            <div className="actionbar__total">
              <span className="muted">Your items so far</span>
              <Pulse value={subtotal}><b data-testid="your-share">{formatGBP(subtotal)}</b></Pulse>
            </div>
            <p className="small muted" data-testid="still-to-claim">{toClaim} {toClaim === 1 ? 'line' : 'lines'} still to claim. You’ll see what you owe then.</p>
            <Button disabled={subtotal <= 0} onClick={() => setView('waiting')}>{subtotal > 0 ? 'I’ve claimed mine' : 'Claim what you had'}</Button>
          </>
        ) : null}
        {!holding && owed > 0 ? (
          <div className="actionbar__total">
            <span className="muted">{paidSome ? `Paid ${formatGBP(l!.sentPence)} · still to pay` : totalLabel(rate > 0, fee > 0)}</span>
            <Pulse value={paidSome ? due : owed}><b data-testid="your-share">{formatGBP(paidSome ? due : owed)}</b></Pulse>
          </div>
        ) : null}
        {holding ? null : paidSome ? (
          <Button href={`/session/${s.sessionId}/pay`} disabled={due <= 0}>
            {due > 0 ? `Pay ${hostFirst} ${formatGBP(due)}` : 'Claim what else you had'}
          </Button>
        ) : (
          <Button href={`/session/${s.sessionId}/pay`} disabled={owed <= 0}>
            {owed > 0 ? 'Continue to payment' : 'Claim what you had'}
          </Button>
        )}
      </ActionBar>
    </>
  );
}

/** "Your total incl. service and round-up" */
export function totalLabel(service: boolean, fee: boolean): string {
  const parts = [service ? 'service' : null, fee ? 'round-up' : null].filter(Boolean);
  return parts.length > 0 ? `Your total incl. ${parts.join(' and ')}` : 'Your total';
}

/** "Shared 2 ways with Priya · 1 open" */
export function splitSub(s: Session, share: Share, meUserId: string): string {
  const others = share.userIds.filter((u) => u !== meUserId).map((u) => firstName(s.participants.find((p) => p.userId === u)?.displayName));
  const seats = Math.max(0, share.ways - share.userIds.length);
  return [`Shared ${share.ways} ways${others.length ? ` with ${others.join(', ')}` : ''}`, seats ? `${seats} open` : null].filter(Boolean).join(' · ');
}

/* ============================ waiting for every line (#216) ============================ */

/** What I've claimed so far, each line at its price (a split at my share). */
function myLines(s: Session, b: Bill, meUserId: string): { key: string; name: string; pence: number }[] {
  const me = s.participants.find((p) => p.userId === meUserId);
  if (!me) return [];
  const claimed = [...new Set(me.claimedItemIds)].flatMap((id) => {
    const item = b.items.find((x) => x.itemId === id);
    const n = me.claimedItemIds.filter((x) => x === id).length;
    return item ? [{ key: id, name: n > 1 ? `${item.name} × ${n}` : item.name, pence: item.unitPricePence * n }] : [];
  });
  const shared = me.sharedItemIds.flatMap((id) => {
    const item = b.items.find((x) => x.itemId === id);
    const share = s.shares?.find((x) => x.itemId === id);
    return item && share ? [{ key: `${id}:split`, name: `${item.name} (shared)`, pence: sharePence(splitPricePence(item, share), share.userIds, share.ways, meUserId) }] : [];
  });
  return [...claimed, ...shared];
}

type OpenLine = { key: string; name: string; pence: number };

/**
 * Keeps a line that's gone on screen for a moment, marked as leaving, so it
 * can fade and fold away (#216). Instant under reduced motion.
 */
function useFolding(lines: OpenLine[]): (OpenLine & { leaving?: boolean })[] {
  const [gone, setGone] = useState<OpenLine[]>([]);
  const last = useRef(lines);
  const keys = lines.map((l) => l.key).join('|');
  useEffect(() => {
    const now = new Set(lines.map((l) => l.key));
    const left = last.current.filter((l) => !now.has(l.key));
    last.current = lines;
    if (left.length === 0 || reducedMotion()) return;
    setGone((g) => [...g.filter((x) => !now.has(x.key)), ...left]);
    const t = setTimeout(() => setGone((g) => g.filter((x) => !left.some((l) => l.key === x.key))), 320);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys]);
  const here = new Set(lines.map((l) => l.key));
  return [...lines, ...gone.filter((g) => !here.has(g.key)).map((g) => ({ ...g, leaving: true }))];
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * G2.2: claimed mine, waiting for the table. The lines nobody has are listed
 * without Claim buttons (*Claim something else* goes back) and fold away as
 * people claim them. Polls with the session; *See what you owe* once the
 * last one goes (or the lead opens payments early).
 */
function WaitingForTable({ s, b, meUserId, onBack, onSee }: { s: Session; b: Bill; meUserId: string; onBack: () => void; onSee: () => void }) {
  const mine = myLines(s, b, meUserId);
  const hostFirst = firstName(s.participants.find((p) => p.userId === s.creatorUserId)?.displayName);
  const open = paymentsOpen(s, b);
  const everything = allClaimed(s, b);
  const left = useMemo(
    () => claimRows(s, b, meUserId).filter((r) => r.group === 'open').map((r) => ({
      key: r.key,
      name: r.kind === 'multi' && r.left > 1 ? `${r.left} × ${r.item.name}` : r.item.name,
      pence: openPence(r),
    })),
    [s, b, meUserId],
  );
  const rows = useFolding(left);
  return (
    <>
      <Page sub>
        <BackButton onClick={onBack}>Claim something else</BackButton>
        <Title title={!open ? 'Waiting for the table' : everything ? 'Every item on the bill is claimed' : `${hostFirst} has opened payments`} />
        <p className="wait-line" role="status" data-testid="wait-status">
          {open ? null : <span className="wait-dot" aria-hidden="true" />}
          {open ? 'You can see what you owe.' : 'Waiting for everyone to claim. You’ll see what you owe once every line’s claimed.'}
        </p>
        <Section title="You claimed">
          <Box list>{mine.map((l) => <Row key={l.key} title={l.name} end={formatGBP(l.pence)} />)}</Box>
        </Section>
        {rows.length > 0 ? (
          <Section title="Nobody’s claimed these yet">
            <Box list>
              {rows.map((l) => (
                <div key={l.key} className={l.leaving ? 'leaving' : undefined} aria-hidden={l.leaving || undefined} data-testid="nobody-row">
                  <Row title={l.name} end={formatGBP(l.pence)} muted />
                </div>
              ))}
            </Box>
          </Section>
        ) : null}
      </Page>
      {open ? (
        <ActionBar>
          <Button grow onClick={onSee}>See what you owe</Button>
        </ActionBar>
      ) : null}
    </>
  );
}

/** G2.3: the lead has opened payments, so here's what you owe. */
/**
 * The guest's share as a receipt (#222): their lines, service, the round-up,
 * then `children` for the last lines (You owe, Sent to Callum…). `stamp`
 * marks it SENT (waiting for the lead) or PAID (All square).
 */
export function ShareReceipt({ s, b, meUserId, owed, stamp, children }: { s: Session; b: Bill; meUserId: string; owed: number; stamp?: 'sent' | 'paid'; children: ReactNode }) {
  const mine = myLines(s, b, meUserId);
  const subtotal = mine.reduce((a, l) => a + l.pence, 0);
  const fee = projectFeePence(s, b, meUserId);
  const extras = Math.max(0, owed - subtotal - fee);
  return (
    <Receipt label="Your share" head={b.venue?.name ?? 'Your share'}>
      {mine.map((l) => <ReceiptLine key={l.key} name={l.name} price={(l.pence / 100).toFixed(2)} />)}
      {extras > 0 ? <ReceiptLine quiet name="Service" price={(extras / 100).toFixed(2)} /> : null}
      {fee > 0 ? <ReceiptLine quiet name="Round-up" price={(fee / 100).toFixed(2)} /> : null}
      {children}
      {stamp ? <div className="receipt__stamp"><span className={stamp === 'sent' ? 'stamp-paid stamp-paid--sent' : 'stamp-paid'}>{stamp === 'sent' ? 'SENT' : 'PAID'}</span></div> : null}
    </Receipt>
  );
}

function WhatYouOwe({ s, b, meUserId, owed, onChange }: { s: Session; b: Bill; meUserId: string; owed: number; onChange: () => void }) {
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = firstName(host?.displayName);
  return (
    <>
      <Page sub>
        {/* G3.1: opened before every line was claimed. */}
        {openedEarly(s, b) ? <Notice>{hostFirst} opened payments before every line was claimed. What you owe won’t change.</Notice> : null}
        <Title title={`You owe ${hostFirst}`} />
        <p className="owed-big" data-testid="your-share">{formatGBP(owed)}</p>
        <ShareReceipt s={s} b={b} meUserId={meUserId} owed={owed}>
          <ReceiptLine strong name="You owe" price={formatGBP(owed)} />
        </ShareReceipt>
      </Page>
      <ActionBar stack>
        <Button href={`/session/${s.sessionId}/pay`}>Pay {hostFirst} {formatGBP(owed)}</Button>
        <Button tone="text" onClick={onChange}>Change what I had</Button>
      </ActionBar>
    </>
  );
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
  const more = !closed && open.length > 0 && onMore
    ? <Button tone="text" onClick={onMore}>I had something else</Button>
    : null;
  // #226: proof of payment, offered 30s after *I've paid* (server time).
  const saidPaidAt = l?.waiting.map((e) => e.payerClaimedPaidAt).filter((x): x is string => !!x).sort()[0];
  const proofOffered = useProofOffered(saidPaidAt);
  const [cropping, setCropping] = useState(false);

  // G4.3 All square: the lead has all of it.
  if (me && l?.settled) {
    return (
      <>
        <Page sub>
          {isGuest ? null : <BackLink href="/">Bills</BackLink>}
          <Title vt={billTitle(s.sessionId)} title="All square" sub={<>{closed ? <><Badge tone="ok">Settled</Badge> </> : null}{hostFirst} got your {formatGBP(l.confirmedPence)}. Nothing more to do.</>} />
          <ShareReceipt s={s} b={b} meUserId={meUserId} owed={myOwed} stamp="paid">
            <ReceiptLine strong name={`Paid to ${hostFirst}`} price={formatGBP(l.confirmedPence)} />
          </ShareReceipt>
          <p className="small muted" role="status">{hostFirst} marked it received.{closed ? null : ` ${hostFirst} marks the bill as settled once everyone’s paid.`}</p>
        </Page>
        <ActionBar stack>
          {more}
          {isGuest ? null : <Button tone={closed ? 'primary' : 'secondary'} href="/" replace>{closed ? 'Done' : 'Back to bills'}</Button>}
        </ActionBar>
      </>
    );
  }
  // G4 Waiting: sent, and the lead hasn't marked it received yet.
  if (me && !mustPay && waitingPence > 0) {
    return (
      <>
        <Page sub>
          {isGuest ? null : <BackLink href="/">Bills</BackLink>}
          <Title vt={billTitle(s.sessionId)} title={`Waiting for ${hostFirst}`} sub={`You’ve sent ${formatGBP(waitingPence)}.`} />
          <ShareReceipt s={s} b={b} meUserId={meUserId} owed={myOwed} stamp="sent">
            {l && l.confirmedPence > 0 ? <ReceiptLine quiet name={`${hostFirst} has`} price={formatGBP(l.confirmedPence)} /> : null}
            <ReceiptLine strong name={`Sent to ${hostFirst}`} price={formatGBP(waitingPence)} />
          </ShareReceipt>
          <div className="wait-box" role="status" aria-live="polite">
            <span className="wait-box__ring" aria-hidden="true"><b>£</b></span>
            <span><b>Waiting for {hostFirst} to mark it received</b><span>This page updates by itself.</span></span>
          </div>
          {proofOffered ? <ProofOfPayment sessionId={s.sessionId} host={hostFirst} onCropping={setCropping} /> : null}
          <Comments sessionId={s.sessionId} meUserId={meUserId} />
        </Page>
        {cropping ? null : (
          <ActionBar stack>
            <Button tone="secondary" href={`/session/${s.sessionId}/pay`}>See {hostFirst}’s bank details</Button>
            {more}
          </ActionBar>
        )}
      </>
    );
  }

  return (
    <>
      <Page sub>
        {isGuest ? null : <BackLink href="/">Bills</BackLink>}
        <Title vt={billTitle(s.sessionId)} title={b.venue?.name ?? `${hostFirst}’s bill`} sub={closed ? 'Settled' : `${hostFirst}’s bill`} aside={<BillTools sessionId={s.sessionId} billId={s.billId} showQr={!closed && !!s.joinCode} />} />
        {mustPay ? <Notice title={`You owe ${hostFirst} ${formatGBP(due)}${l && l.sentPence > 0 ? ' more' : ''}`} /> : null}

        {me && (me.claimedItemIds.length > 0 || me.sharedItemIds.length > 0) ? (
          <Section title="You had">
            <Box list>
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
              {myFee > 0 ? <TotalLine tone="mute" k="Round-up" v={formatGBP(myFee)} /> : null}
              <TotalLine tone="total" k={totalLabel(b.serviceChargePence > 0 || b.taxPence > 0, myFee > 0)} v={formatGBP(myOwed)} />
            </Totals>
          </Section>
        ) : null}

        {sentPayments.length > 1 || (sentPayments.length === 1 && mustPay) ? (
          <Section title="Your payments">
            <Box list>
              {sentPayments.map((e) => (
                <Row key={e.paymentId} title={formatGBP(e.amountPence)} end={e.status === 'succeeded' ? <Badge tone="ok">Confirmed</Badge> : <Badge>Waiting for {hostFirst}</Badge>} />
              ))}
            </Box>
          </Section>
        ) : null}

        {!closed && open.length > 0 ? (
          <Section title="Still to claim">
            <Box list>{open.map((st) => <ItemLine key={st.item.itemId} st={st} />)}</Box>
          </Section>
        ) : null}

        {!closed ? <p className="small muted">{hostFirst} marks the bill as settled once everyone’s paid.</p> : null}
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

