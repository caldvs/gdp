'use client';

/**
 * The lead's side of a live bill: who's paid, what's still unclaimed (the
 * lead can take it, or cover the lot), and one way out: Close bill.
 * Everything updates on the session's poll.
 */
import { startTransition, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { components } from '@gdp/core/api';
import { isFeeRequired, useAbandonSession, useAddShare, useCloseSession, useOpenPayments, useSetClaims, useSetExpectedDiners, useShareSession } from '@gdp/core/api/hooks/useSession';
import { useMyBilling } from '@gdp/core/api/hooks/useTableFee';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { useMarkReceived } from '@gdp/core/api/hooks/usePaymentActions';
import { formatGBP } from '@gdp/core/lib/money';
import { ledger } from '@gdp/core/lib/ledger';
import { claimRows, openPence, type ClaimRow } from '@gdp/core/lib/claimRows';
import { extrasRate, projectFeePence, projectOwedPence, sharePence, splitPricePence } from '@gdp/core/lib/owed';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import {
  ActionBar, Avatar, BackLink, Badge, Box, Button, Dialog, Notice, Page, Pulse, Row, RowButton, RowLink, Section, TabPanel, Tabs, Title, TotalLine, Totals, firstName,
} from '@/components/ui';
import { BillTools } from '@/components/BillTools';
import { useTableFeed } from '@/components/useTableFeed';
import { billTitle } from '@/components/PageTransition';
import { itemStatuses } from './guest';
import { paymentsOpen, unclaimedLines } from '@gdp/core/lib/leftovers';
import { ClaimList } from './claim';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];

function owedFor(s: Session, b: Bill, p: Participant): number {
  return p.owedPence ?? projectOwedPence(s, b, p.userId);
}
// #121: a guest can pay more than once; the lead has collected what's been
// confirmed, and a guest is done when nothing is due or waiting.
const confirmedFor = (s: Session, b: Bill, p: Participant) => ledger(p, owedFor(s, b, p)).confirmedPence;
const isPaid = (s: Session, b: Bill, p: Participant) => ledger(p, owedFor(s, b, p)).settled;
const stillToCollect = (s: Session, b: Bill, p: Participant) => Math.max(0, owedFor(s, b, p) - confirmedFor(s, b, p));

/* ============================ setup ============================ */

export function LeadSetup({ s, b }: { s: Session; b: Bill }) {
  const router = useRouter();
  const share = useShareSession(s.sessionId);
  const payout = usePayoutAccount();
  const onShare = () => {
    if (!payout.data) { router.push(`/payout-account?returnTo=${encodeURIComponent(`/session/${s.sessionId}`)}`); return; }
    share.mutate(undefined, {
      onSuccess: () => router.replace(`/session/${s.sessionId}/share?new=1`),
      // No fee or credit for it: pay first, then the fee page shares this table.
      onError: (err) => { if (isFeeRequired(err)) router.push(`/table-fee/${s.billId}`); },
    });
  };
  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title vt={billTitle(s.sessionId)} title={b.venue?.name ?? 'Your bill'} sub={`${b.items.length} ${b.items.length === 1 ? 'item' : 'items'} · ${formatGBP(b.totalPence)} · not shared yet`} />
        {share.isError && !isFeeRequired(share.error) ? <Notice tone="error">{share.error.message}</Notice> : null}
      </Page>
      <ActionBar>
        <Button tone="secondary" href={`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`}>Edit bill</Button>
        <Button grow busy={share.isPending} onClick={onShare}>Share with the table</Button>
      </ActionBar>
    </>
  );
}

/* ============================ the bill ============================ */

type LeadTab = 'mine' | 'table';

/**
 * The lead's live bill (#131, board L4.1/L4.2): two tabs. Your items is
 * the same claiming list guests use; The table is who's paid, what nobody
 * has claimed yet, and the way to the full summary.
 */
export function LeadTable({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const router = useRouter();
  const close = useCloseSession(s.sessionId);
  const abandon = useAbandonSession(s.sessionId);
  const received = useReceived(s, b);
  const me = s.participants.find((p) => p.userId === meUserId);
  // Straight after sharing the lead has nothing yet: start on their items.
  const [tab, setTab] = useState<LeadTab>(() => (me && (me.claimedItemIds.length > 0 || me.sharedItemIds.length > 0) ? 'table' : 'mine'));
  const [leftOpen, setLeftOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [binning, setBinning] = useState(false);
  // #64: how many the lead said are eating, lead included. Display only.
  const setExpected = useSetExpectedDiners(s.sessionId);
  const [sizing, setSizing] = useState<number | null>(null);
  const joined = s.participants.length;
  const everyoneHere = s.expectedDiners !== undefined && joined >= s.expectedDiners;

  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const toCome = guests.reduce((acc, p) => acc + stillToCollect(s, b, p), 0);
  // Nobody joined: closing or deleting gives back what sharing cost (#132).
  const spent = useSpent(s.sessionId, guests.length === 0);
  const giveBack = spent.fee?.kind === 'hold' && !spent.fee.releasedAt ? `Nobody joined, so your ${formatGBP(spent.fee.amountPence)} hold is released.`
    : spent.fee && spent.fee.kind !== 'hold' && !spent.fee.refundedAt ? `Nobody joined, so your ${formatGBP(spent.fee.amountPence)} fee is refunded.`
    : spent.credit && !spent.credit.returnedAt ? 'Nobody joined, so you get your credit back.' : null;
  // At close the round-ups of the payments you confirmed come off the hold, at most the hold.
  // Guests say they've paid but you confirmed none: the whole hold.
  const confirmed = guests.filter((p) => (p.payments ?? []).some((e) => e.status === 'succeeded') || p.payment.status === 'succeeded');
  const anySent = guests.some((p) => (p.payments ?? []).some((e) => e.status === 'succeeded' || !!e.payerClaimedPaidAt) || p.payment.status === 'succeeded' || ('payerClaimedPaidAt' in p.payment && !!p.payment.payerClaimedPaidAt));
  const hold = s.platformFeePence ?? 0;
  const guestFees = Math.min(hold, confirmed.length === 0 && anySent ? hold : confirmed.reduce((acc, p) => acc + projectFeePence(s, b, p.userId), 0));
  const holdNote = hold && guests.length > 0
    ? guestFees >= 30 ? `${formatGBP(guestFees)} of your ${formatGBP(hold)} hold is taken: your guests’ round-ups.` : `Your ${formatGBP(hold)} hold is released.`
    : null;
  const rate = extrasRate(b);
  const myOwed = projectOwedPence(s, b, meUserId);
  const rows = useMemo(() => claimRows(s, b, meUserId), [s, b, meUserId]);
  const left = rows.filter((r) => r.group === 'open');
  const leftPence = left.reduce((acc, r) => acc + openPence(r), 0);
  const leftWithService = Math.round(leftPence * (1 + rate));
  const myItems = rows.filter((r) => r.group === 'yours').map((r) => r.item.name);
  const feed = useTableFeed(s.participants, s.creatorUserId, (p) => owedFor(s, b, p));

  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <div className="vh" aria-live="polite" data-testid="table-feed">{feed}</div>
        <Title vt={billTitle(s.sessionId)} title={b.venue?.name ?? 'Your bill'} sub={`${s.participants.length} ${s.participants.length === 1 ? 'person' : 'people'}`} aside={<BillTools sessionId={s.sessionId} billId={s.billId} showQr={!!s.joinCode} onDelete={() => setBinning(true)} />} />
        <Tabs label="The bill" value={tab} onChange={(t) => startTransition(() => setTab(t))} tabs={[{ id: 'mine', label: 'Your items' }, { id: 'table', label: 'The table' }]} />

        {tab === 'mine' ? (
          <TabPanel id="mine">
            <ClaimList s={s} b={b} meUserId={meUserId} />
          </TabPanel>
        ) : (
          <TabPanel id="table">
            <Section
              title={s.expectedDiners !== undefined ? `People · ${joined} of ${s.expectedDiners} joined` : 'People'}
              aside={
                <button type="button" className="link-btn small" onClick={() => { setExpected.reset(); setSizing(s.expectedDiners ?? Math.max(2, joined)); }}>
                  {s.expectedDiners !== undefined ? 'Change number' : 'How many eating?'}
                </button>
              }
            >
              <Box list>
                <RowButton
                  onClick={() => startTransition(() => setTab('mine'))}
                  action="Your items:"
                  lead={<Avatar name={me?.displayName || 'You'} you />}
                  title="You"
                  sub={myItems.length > 0 ? myItems.join(', ') : 'Claim your items'}
                  end={<Pulse value={myOwed}><span data-testid="lead-share">{formatGBP(myOwed)}</span></Pulse>}
                />
                {guests.length === 0 ? (
                  <Row title="Nobody’s joined yet" sub="Show them the QR code." muted />
                ) : guests.map((p) => (
                  <PersonRow key={p.userId} s={s} b={b} p={p} onReceived={received.ask} busy={received.busy} />
                ))}
              </Box>
            </Section>

            <OpenPayments s={s} b={b} leftPence={leftWithService} />

            {everyoneHere && left.length > 0 ? (
              <Notice tone="warn" title="Everyone’s here">{formatGBP(leftWithService)} still not claimed.</Notice>
            ) : null}
            <Box>
              {left.length > 0 ? (
                <RowButton onClick={() => setLeftOpen(true)} title={`Not claimed · ${left.length} ${left.length === 1 ? 'item' : 'items'}`} end={formatGBP(leftWithService)} chevron />
              ) : null}
              <RowLink href={`/session/${s.sessionId}/summary`} title="Full summary" />
            </Box>

          </TabPanel>
        )}
      </Page>
      {tab === 'mine' ? (
        <ActionBar stack>
          <div className="actionbar__total">
            <span className="muted">{`Your share${rate > 0 ? ' incl. service' : ''}`}</span>
            <Pulse value={myOwed}><b data-testid="your-share">{formatGBP(myOwed)}</b></Pulse>
          </div>
          <Button onClick={() => startTransition(() => setTab('table'))}>Done</Button>
        </ActionBar>
      ) : (
        <ActionBar>
          <Button tone="secondary" href={`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`}>Edit bill</Button>
          <Button grow onClick={() => setClosing(true)}>Close bill</Button>
        </ActionBar>
      )}

      {received.sheet}
      {leftOpen ? <NotClaimedSheet s={s} rows={left} meUserId={meUserId} onClose={() => startTransition(() => setLeftOpen(false))} /> : null}
      {sizing !== null ? (
        <PartySizeSheet
          n={sizing}
          min={2}
          busy={setExpected.isPending}
          error={setExpected.error?.message}
          canClear={s.expectedDiners !== undefined}
          onChange={setSizing}
          onCancel={() => startTransition(() => setSizing(null))}
          onOk={(expectedDiners) => setExpected.mutate({ expectedDiners }, { onSuccess: () => startTransition(() => setSizing(null)) })}
        />
      ) : null}
      {closing ? (
        <Confirm
          title="Close the bill?"
          body={giveBack ?? ([
            leftPence > 0 ? `Nobody claimed ${formatGBP(leftWithService)}. It goes on you.` : null,
            toCome > 0 ? `${formatGBP(toCome)} still to collect. People can still pay.` : null,
            holdNote,
          ].filter(Boolean).join(' ') || 'Everyone has paid.')}
          ok="Close bill"
          busy={close.isPending}
          error={close.error?.message}
          onOk={() => close.mutate(undefined, { onSuccess: () => startTransition(() => setClosing(false)) })}
          onCancel={() => startTransition(() => setClosing(false))}
        />
      ) : null}
      {binning ? (
        <Confirm
          title="Delete this bill?"
          body={guests.length > 0 ? `${guests.length} ${guests.length === 1 ? 'person loses' : 'people lose'} their picks. This can’t be undone.` : giveBack ?? 'This can’t be undone.'}
          ok="Delete bill"
          danger
          busy={abandon.isPending}
          error={abandon.error?.message}
          onOk={() => abandon.mutate(undefined, { onSuccess: () => router.replace('/') })}
          onCancel={() => startTransition(() => setBinning(false))}
        />
      ) : null}
    </>
  );
}

/**
 * L5.0 (#216): payments open by themselves once every line is claimed.
 * Until then the lead sees how many are left and can open them now, after a
 * confirm in place saying what that puts on them.
 */
function OpenPayments({ s, b, leftPence }: { s: Session; b: Bill; leftPence: number }) {
  const openPay = useOpenPayments(s.sessionId);
  const [asking, setAsking] = useState(false);
  if (s.status !== 'claiming' || paymentsOpen(s, b)) return null;
  const n = unclaimedLines(s, b).length;
  const go = () => openPay.mutate(undefined, { onSuccess: () => setAsking(false) });
  if (!asking) {
    return (
      <div className="open-pay">
        <p className="open-pay__line" data-testid="open-pay-status">{n} {n === 1 ? 'line' : 'lines'} still to claim</p>
        <p className="small muted">Guests see what they owe once every line’s claimed.</p>
        <Button tone="secondary" onClick={() => { openPay.reset(); setAsking(true); }}>Open payments now</Button>
      </div>
    );
  }
  return (
    <div className="confirm-inline" role="group" aria-labelledby="open-pay-t">
      <h2 id="open-pay-t" className="confirm-inline__h">Open payments with lines unclaimed?</h2>
      <p className="muted">Guests see what they owe and your bank details. Anything nobody claims goes on you.</p>
      <Totals><TotalLine k="Nobody claimed · goes on you" v={formatGBP(leftPence)} /></Totals>
      <div className="confirm-inline__acts">
        <Button tone="secondary" small onClick={() => setAsking(false)}>Keep waiting</Button>
        <Button small busy={openPay.isPending} onClick={go}>Open payments</Button>
      </div>
      {openPay.error ? <Notice tone="error">{openPay.error.message}</Notice> : null}
    </div>
  );
}


const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * L4.2's Not claimed sheet: Claim takes a line (every portion left of it)
 * onto the lead's share; a split's open spot is joined. The row slides out
 * and the list closes up. Anything left goes on the lead at close anyway.
 */
function NotClaimedSheet({ s, rows, meUserId, onClose }: { s: Session; rows: ClaimRow[]; meUserId: string; onClose: () => void }) {
  const setClaims = useSetClaims(s.sessionId);
  const addShare = useAddShare(s.sessionId);
  const [leaving, setLeaving] = useState<string | null>(null);
  const me = s.participants.find((p) => p.userId === meUserId);
  const take = (r: ClaimRow) => {
    if (!me || leaving) return;
    setLeaving(r.key);
    const last = rows.length === 1;
    const done = { onSuccess: () => { if (last) onClose(); }, onSettled: () => setLeaving(null) };
    setTimeout(() => {
      if (r.share) addShare.mutate({ itemId: r.item.itemId }, done);
      else setClaims.mutate({ claimedItemIds: [...me.claimedItemIds, ...Array<string>(r.left).fill(r.item.itemId)] }, done);
    }, reducedMotion() ? 0 : 280);
  };
  const err = setClaims.error?.message ?? addShare.error?.message;
  return (
    <Dialog id="left-t" title="Not claimed" onClose={onClose} actions={<Button tone="secondary" onClick={onClose}>Close</Button>}>
      <Box list>
        {rows.map((r) => (
          <div key={r.key} className={`claim${leaving === r.key ? ' leaving' : ''}`}>
            <span className="row__main">
              <span className="row__title">{r.kind === 'multi' && r.left > 1 ? `${r.left} × ${r.item.name}` : r.kind === 'share' && r.count > 1 ? `${r.count} × ${r.item.name}` : r.item.name}</span>
              <span className="row__sub">{formatGBP(openPence(r))}</span>
            </span>
            <Button tone="secondary" small className="claim__btn" disabled={!!leaving} onClick={() => take(r)} aria-label={`Claim ${r.item.name}, ${formatGBP(openPence(r))}`}>Claim</Button>
          </div>
        ))}
      </Box>
      <p className="small muted">Anything left goes on yours when you close.</p>
      {err ? <Notice tone="error">{err}</Notice> : null}
    </Dialog>
  );
}

/** What a guest has claimed, by name: "Lasagne, 2 × Negroni, Calamari (split)". */
export function claimedNames(b: Bill, p: Participant): string {
  const counts = new Map<string, number>();
  for (const id of p.claimedItemIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const names: string[] = [];
  for (const item of b.items) {
    const n = counts.get(item.itemId);
    if (n) names.push(n > 1 ? `${n} × ${item.name}` : item.name);
    if (p.sharedItemIds.includes(item.itemId)) names.push(`${item.name} (split)`);
  }
  return names.join(', ');
}

/**
 * One guest on the lead's list: what they've claimed and what that comes
 * to, live, and Received for when their money lands (the lead usually sees
 * it as a banking app notification), whether or not they've said they paid.
 */
function PersonRow({ s, b, p, onReceived, busy }: { s: Session; b: Bill; p: Participant; onReceived: (p: Participant) => void; busy: boolean }) {
  const name = firstName(p.displayName, 'Guest');
  const av = <Avatar name={p.displayName || name} />;
  const owed = owedFor(s, b, p);
  const l = ledger(p, owed);
  const items = claimedNames(b, p);
  if (owed === 0 && l.confirmedPence === 0) return <Row lead={av} title={name} sub="Nothing claimed yet" />;
  const amount = <Pulse value={owed}><span>{formatGBP(owed)}</span></Pulse>;
  if (l.settled) {
    return <Row lead={av} title={name} sub={items} end={<span className="person__end">{amount}<Badge tone="ok">Paid</Badge></span>} />;
  }
  // What they say they've sent, so the lead can match it to their bank.
  const says = l.waiting.reduce((acc, e) => acc + e.amountPence, 0);
  const status = says > 0
    ? `Says they’ve paid ${formatGBP(says)}${l.confirmedPence > 0 ? ' more' : ''}`
    : l.confirmedPence > 0 ? `Owes ${formatGBP(owed - l.confirmedPence)} more` : null;
  return (
    <Row
      lead={av}
      title={name}
      sub={status ? `${status} · ${items}` : items}
      end={
        <span className="person__end">
          {amount}
          <Button small tone="secondary" disabled={busy} onClick={() => onReceived(p)} aria-label={`${name}’s ${formatGBP(owed - l.confirmedPence)} received`}>Received</Button>
        </span>
      }
    />
  );
}

/** Received, asked once first: it tells the guest they're paid up, and can't be undone. */
function useReceived(s: Session, b: Bill) {
  const mark = useMarkReceived(s.sessionId);
  const [who, setWho] = useState<Participant | null>(null);
  const close = () => startTransition(() => { mark.reset(); setWho(null); });
  const due = who ? Math.max(0, owedFor(s, b, who) - ledger(who, owedFor(s, b, who)).confirmedPence) : 0;
  const sheet = who ? (
    <Confirm
      title={`${formatGBP(due)} from ${firstName(who.displayName, 'them')}?`}
      body="Only once it’s in your account. They’ll see they’re paid up."
      ok="Received"
      busy={mark.isPending}
      error={mark.error?.message}
      onOk={() => mark.mutate(who.userId, { onSuccess: close })}
      onCancel={close}
    />
  ) : null;
  return { ask: (p: Participant) => { mark.reset(); setWho(p); }, busy: mark.isPending, sheet };
}

/* ============================ closed ============================ */

export function LeadSettled({ s, b }: { s: Session; b: Bill }) {
  // Guests can still pay after the bill is closed, so the lead can still mark it received.
  const received = useReceived(s, b);
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const outstanding = guests.filter((p) => !isPaid(s, b, p));
  const collected = guests.reduce((acc, p) => acc + confirmedFor(s, b, p), 0);
  // The guests' platform fee is on top of the bill, so it isn't taken off the lead's part.
  const yourPart = Math.max(0, b.totalPence - guests.reduce((acc, p) => acc + owedFor(s, b, p) - projectFeePence(s, b, p.userId), 0));
  const unclaimed = itemStatuses(s, b, s.creatorUserId).filter((x) => x.left > 0);
  const spent = useSpent(s.sessionId);
  const feed = useTableFeed(s.participants, s.creatorUserId, (p) => owedFor(s, b, p));
  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <div className="vh" aria-live="polite" data-testid="table-feed">{feed}</div>
        <Title vt={billTitle(s.sessionId)} title={b.venue?.name ?? 'Your bill'} sub="Bill closed" aside={<BillTools sessionId={s.sessionId} billId={s.billId} showQr={false} />} />
        {outstanding.length === 0
          ? <Notice tone="ok" title={`${formatGBP(collected)} collected`}>Everyone has paid.</Notice>
          : <Notice title={`${outstanding.length} still to pay`}>{formatGBP(collected)} collected so far.</Notice>}
        {guests.length > 0 ? (
          <Section title="People">
            <Box list>{guests.map((p) => (
              <PersonRow key={p.userId} s={s} b={b} p={p} onReceived={received.ask} busy={received.busy} />
            ))}</Box>
          </Section>
        ) : null}
        {unclaimed.length > 0 ? (
          <Section title="Nobody claimed these">
            <Box list>{unclaimed.map(({ item, left }) => (
              <Row key={item.itemId} title={left > 1 ? `${item.name} × ${left}` : item.name} end={formatGBP(item.unitPricePence * left)} />
            ))}</Box>
          </Section>
        ) : null}
        {spent.fee ? (
          <Section title="Platform fee">
            {spent.fee.kind === 'hold' ? (
              <Box>
                {spent.fee.capturedAt
                  ? <Row title="Taken from your hold" sub="Your guests’ round-ups" end={formatGBP(spent.fee.capturedPence ?? 0)} />
                  : <Row title={spent.fee.releasedAt ? 'Hold released' : 'Hold on your card'} end={formatGBP(spent.fee.amountPence)} />}
              </Box>
            ) : (
              <Box><Row title={spent.fee.refundedAt ? 'Refunded' : 'Paid when you shared'} end={formatGBP(spent.fee.amountPence)} /></Box>
            )}
          </Section>
        ) : spent.credit?.returnedAt ? (
          <Section title="Platform fee">
            <Box><Row title="Credit given back" end="1 credit" /></Box>
          </Section>
        ) : null}
        <Totals>
          <TotalLine k="Bill" v={formatGBP(b.totalPence)} />
          <TotalLine tone="total" k="Your part" v={formatGBP(yourPart)} />
        </Totals>
        <Box><RowLink href={`/session/${s.sessionId}/summary`} title="Full summary" /></Box>
      </Page>
      <ActionBar><Button grow href="/" replace>Done</Button></ActionBar>
      {received.sheet}
    </>
  );
}

/** The platform fee or credit that paid for sharing this session, if any. */
export function useSpent(sessionId: string, enabled = true) {
  const billing = useMyBilling({ enabled: enabled && !!STRIPE_PUBLISHABLE_KEY });
  const data = enabled ? billing.data : null;
  return {
    fee: data?.fees.find((f) => f.sessionId === sessionId),
    credit: data?.credits.find((c) => c.sessionId === sessionId),
  };
}

/* ============================ deleted ============================ */

export function Ended({ s, isCreator }: { s: Session; isCreator: boolean }) {
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title="This bill was deleted" sub={isCreator ? 'You can scan the bill again to start over.' : `${firstName(host?.displayName)} deleted it.`} />
      </Page>
      <ActionBar><Button grow href="/" replace>Back to bills</Button></ActionBar>
    </>
  );
}

/* ============================ bits ============================ */

const PARTY_MAX = 99;

function PartySizeSheet({ n, min, busy, error, canClear, onChange, onCancel, onOk }: {
  n: number; min: number; busy: boolean; error?: string; canClear: boolean; onChange: (n: number) => void; onCancel: () => void; onOk: (n: number | null) => void;
}) {
  return (
    <Dialog
      id="party-t"
      title="How many eating?"
      onClose={onCancel}
      actions={
        <>
          <Button busy={busy} onClick={() => onOk(n)}>Save</Button>
          {canClear ? <Button tone="secondary" disabled={busy} onClick={() => onOk(null)}>Not sure</Button> : null}
          <Button tone="secondary" onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <p className="muted">Including you.</p>
      <div className="ways">
        <span className="stepper">
          <button type="button" aria-label="Fewer people" disabled={n <= min} onClick={() => onChange(n - 1)}>−</button>
        </span>
        <b aria-live="polite">{n}</b>
        <span className="stepper">
          <button type="button" aria-label="More people" disabled={n >= PARTY_MAX} onClick={() => onChange(n + 1)}>+</button>
        </span>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Dialog>
  );
}

function Confirm({ title, body, ok, danger, busy, error, onOk, onCancel }: {
  title: string; body: string; ok: string; danger?: boolean; busy: boolean; error?: string; onOk: () => void; onCancel: () => void;
}) {
  return (
    <Dialog
      id="confirm-t"
      describedBy="confirm-d"
      title={title}
      onClose={onCancel}
      actions={
        <>
          <Button tone={danger ? 'danger' : 'primary'} busy={busy} onClick={onOk}>{ok}</Button>
          <Button tone="secondary" onClick={onCancel}>Not yet</Button>
        </>
      }
    >
      <p id="confirm-d" className="muted">{body}</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Dialog>
  );
}
