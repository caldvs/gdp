'use client';

/**
 * The lead's side of a live bill: who's paid, what's still unclaimed (the
 * lead can take it, or cover the lot), and one way out: Close bill.
 * Everything updates on the session's poll.
 */
import { Comments } from '@/components/Comments';
import { useProofs } from '@gdp/core/api/hooks/useProofs';
import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { components } from '@gdp/core/api';
import { isFeeRequired, useAbandonSession, useCloseSession, useOpenPayments, useSetExpectedDiners, useShareSession } from '@gdp/core/api/hooks/useSession';
import { useMyBilling } from '@gdp/core/api/hooks/useTableFee';
import { STRIPE_PUBLISHABLE_KEY } from '@/lib/config';
import { useMarkReceived } from '@gdp/core/api/hooks/usePaymentActions';
import { formatGBP } from '@gdp/core/lib/money';
import { ledger } from '@gdp/core/lib/ledger';
import { claimRows, openPence } from '@gdp/core/lib/claimRows';
import { extrasRate, projectFeePence, projectOwedPence } from '@gdp/core/lib/owed';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import {
  ActionBar, Avatar, BackLink, Badge, Box, Button, Dialog, Notice, Page, Pulse, Row, Section, Title, TotalLine, Totals, firstName,
} from '@/components/ui';
import { BillTools } from '@/components/BillTools';
import { useTableFeed } from '@/components/useTableFeed';
import { billTitle } from '@/components/PageTransition';
import { paymentsOpen, unclaimedLines } from '@gdp/core/lib/leftovers';
import { billStatement } from '@gdp/core/lib/statement';
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

/**
 * The lead's live bill, one page (#217, board L5): what needs them, the bill
 * (their Claim on it, lines nobody has tinted), who's paid with *Received*,
 * then *Mark as settled*, which confirms in place at the end. Everything
 * updates on the session's poll.
 */
export function LeadTable({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const router = useRouter();
  const abandon = useAbandonSession(s.sessionId);
  const received = useReceived(s, b);
  const me = s.participants.find((p) => p.userId === meUserId);
  const [binning, setBinning] = useState(false);
  // #64: how many the lead said are eating, lead included. Display only.
  const setExpected = useSetExpectedDiners(s.sessionId);
  const [sizing, setSizing] = useState<number | null>(null);
  // #226: guests' payment screenshots; whose the lead is looking at.
  const anyWaiting = s.participants.some((p) => (p.payments ?? []).some((e) => e.status === 'pending' && !!e.payerClaimedPaidAt));
  const proofs = useProofs(s.sessionId, { poll: 10_000, enabled: anyWaiting });
  const [seeing, setSeeing] = useState<string | null>(null);
  const joined = s.participants.length;
  const everyoneHere = s.expectedDiners !== undefined && joined >= s.expectedDiners;

  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  // Nobody joined: settling or deleting gives back what sharing cost (#132).
  const spent = useSpent(s.sessionId, guests.length === 0);
  const giveBack = giveBackNote(spent);
  const rate = extrasRate(b);
  const myOwed = projectOwedPence(s, b, meUserId);
  const rows = useMemo(() => claimRows(s, b, meUserId), [s, b, meUserId]);
  const left = rows.filter((r) => r.group === 'open');
  const leftWithService = Math.round(left.reduce((acc, r) => acc + openPence(r), 0) * (1 + rate));
  const says = guests.filter((p) => ledger(p, owedFor(s, b, p)).waiting.length > 0);
  // Once everyone's paid for a fully claimed bill, claims are fixed and
  // nobody else needs the QR. With lines still open someone may yet join.
  const everyonePaid = guests.length > 0 && guests.every((p) => isPaid(s, b, p)) && left.length === 0;
  const feed = useTableFeed(s.participants, s.creatorUserId, (p) => owedFor(s, b, p));

  const needs: { key: string; tone: 'info' | 'ok' | 'warn'; text: string }[] = [];
  if (says.length > 0) needs.push({ key: 'says', tone: 'info', text: `${listNames(says.map((p) => firstName(p.displayName, 'Guest')))} ${says.length > 1 ? 'say' : 'says'} they’ve paid. Mark it received when it’s in your account.` });
  if (left.length > 0) needs.push({ key: 'left', tone: 'warn', text: `${everyoneHere ? 'Everyone’s here. ' : ''}${left.length} ${left.length === 1 ? 'line' : 'lines'} nobody’s claimed · ${formatGBP(leftWithService)}. Claim yours below; the rest goes on you once it’s settled.` });
  if (guests.length === 0) needs.push({ key: 'nobody', tone: 'info', text: 'Nobody’s joined yet. Show them the QR code.' });
  else if (says.length === 0 && left.length === 0 && everyonePaid) needs.push({ key: 'done', tone: 'ok', text: 'Everyone’s paid and every line is claimed. You can mark it as settled.' });

  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <div className="vh" aria-live="polite" data-testid="table-feed">{feed}</div>
        <Title
          vt={billTitle(s.sessionId)}
          title={b.venue?.name ?? 'Your bill'}
          sub={`${formatDay(s.createdAt)} · ${joined} at the table · ${formatGBP(b.totalPence)}`}
          aside={<BillTools sessionId={s.sessionId} billId={s.billId} showQr={!!s.joinCode && !everyonePaid} onDelete={() => setBinning(true)} editHref={`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`} />}
        />

        {needs.length > 0 ? (
          <ul className="needs" aria-label="What needs you" data-testid="needs">
            {needs.map((n) => <li key={n.key} className={`needs__item needs__item--${n.tone}`}>{n.text}</li>)}
          </ul>
        ) : null}
        <OpenPayments s={s} b={b} leftPence={leftWithService} />

        <Section title="The bill">
          <div className="lead-bill">
            <ClaimList s={s} b={b} meUserId={meUserId} locked={everyonePaid} />
          </div>
        </Section>

        <Section
          title={s.expectedDiners !== undefined ? `Who’s paid · ${joined} of ${s.expectedDiners} joined` : 'Who’s paid'}
          aside={
            everyonePaid ? null : (
              <button type="button" className="link-btn small" onClick={() => { setExpected.reset(); setSizing(s.expectedDiners ?? Math.max(2, joined)); }}>
                {s.expectedDiners !== undefined ? 'Change number' : 'How many eating?'}
              </button>
            )
          }
        >
          <Box list>
            {guests.map((p) => (
              <PersonRow key={p.userId} s={s} b={b} p={p} onReceived={received.ask} busy={received.busy} proof={proofs.data?.some((x) => x.userId === p.userId)} onSeeProof={() => setSeeing(p.userId)} />
            ))}
            <Row title="You" sub="Your share" end={<Pulse value={myOwed}><span data-testid="lead-share">{formatGBP(myOwed)}</span></Pulse>} />
          </Box>
        </Section>

        <Comments sessionId={s.sessionId} meUserId={meUserId} />

        <Settle s={s} b={b} meUserId={meUserId} leftPence={leftWithService} giveBack={giveBack} />
        <div className="lead-links">
          <Link href={`/session/${s.sessionId}/summary`} className="link-btn">The whole bill</Link>
        </div>
              </Page>

      {received.sheet}
      {seeing ? (
        <Dialog
          title={`${firstName(s.participants.find((p) => p.userId === seeing)?.displayName, 'Their')}’s screenshot`}
          onClose={() => startTransition(() => setSeeing(null))}
          actions={<Button tone="secondary" onClick={() => startTransition(() => setSeeing(null))}>Close</Button>}
        >
          <p className="small muted">A screenshot isn’t payment. Mark it received once it’s in your account.</p>
          {(proofs.data ?? []).filter((x) => x.userId === seeing).map((x) => (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed S3 URL
            <img key={x.proofId} src={x.url} alt="Their payment screenshot" className="proof__full" />
          ))}
        </Dialog>
      ) : null}
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

/** "Sat 31 Oct" */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

/** "Sam", "Sam and Tom", "Priya, Sam and Tom" */
function listNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What settling (or deleting) gives back when nobody joined (#132). */
function giveBackNote(spent: ReturnType<typeof useSpent>): string | null {
  return spent.fee?.kind === 'hold' && !spent.fee.releasedAt ? `Nobody joined, so your ${formatGBP(spent.fee.amountPence)} hold is released.`
    : spent.fee && spent.fee.kind !== 'hold' && !spent.fee.refundedAt ? `Nobody joined, so your ${formatGBP(spent.fee.amountPence)} fee is refunded.`
    : spent.credit && !spent.credit.returnedAt ? 'Nobody joined, so you get your credit back.' : null;
}

/**
 * L5.1: *Mark as settled* at the end of the page, confirmed in place: still
 * to come, your share, the platform fee from the hold, and what nobody
 * claimed (it goes on you). Anyone who still owes can pay after.
 */
function Settle({ s, b, meUserId, leftPence, giveBack }: { s: Session; b: Bill; meUserId: string; leftPence: number; giveBack: string | null }) {
  const close = useCloseSession(s.sessionId);
  const [asking, setAsking] = useState(false);
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const toCome = guests.reduce((acc, p) => acc + stillToCollect(s, b, p), 0);
  const hold = s.platformFeePence ?? 0;
  const fee = Math.min(hold, holdTaken(s, b));
  // Focus moves into the confirm when it opens, and back when it's put away.
  const askRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const back = useRef(false);
  useEffect(() => {
    if (asking) askRef.current?.focus();
    else if (back.current) btnRef.current?.focus();
  }, [asking]);
  if (!asking) {
    return <Button ref={btnRef} className="settle-btn" onClick={() => { close.reset(); setAsking(true); }}>Mark as settled</Button>;
  }
  return (
    <div ref={askRef} tabIndex={-1} className="confirm-inline" role="group" aria-labelledby="settle-t">
      <h2 id="settle-t" className="confirm-inline__h">Mark the bill as settled?</h2>
      {giveBack ? <p className="muted">{giveBack}</p> : (
        <Totals>
          <TotalLine k="Still to come" v={formatGBP(toCome)} />
          <TotalLine k="Your share" v={formatGBP(projectOwedPence(s, b, meUserId))} />
          {hold > 0 ? <TotalLine k="Platform fee · from your hold" v={formatGBP(fee)} /> : null}
          {leftPence > 0 ? <TotalLine k="Nobody claimed · goes on you" v={formatGBP(leftPence)} /> : null}
        </Totals>
      )}
      {toCome > 0 ? <p className="small muted">Anyone who still owes can pay after.</p> : null}
      <div className="confirm-inline__acts">
        <Button tone="secondary" small onClick={() => { back.current = true; setAsking(false); }}>Not yet</Button>
        <Button small busy={close.isPending} onClick={() => close.mutate(undefined)}>Mark as settled</Button>
      </div>
      {close.error ? <Notice tone="error">{close.error.message}</Notice> : null}
    </div>
  );
}

/**
 * What comes off the hold at settle: the round-ups of the payments the lead
 * has confirmed. Guests say they've paid but none is confirmed: the whole
 * hold (#167, as the API does it).
 */
function holdTaken(s: Session, b: Bill): number {
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const hold = s.platformFeePence ?? 0;
  const confirmed = guests.filter((p) => (p.payments ?? []).some((e) => e.status === 'succeeded') || p.payment.status === 'succeeded');
  const anySent = guests.some((p) => (p.payments ?? []).some((e) => e.status === 'succeeded' || !!e.payerClaimedPaidAt) || p.payment.status === 'succeeded' || ('payerClaimedPaidAt' in p.payment && !!p.payment.payerClaimedPaidAt));
  return confirmed.length === 0 && anySent ? hold : confirmed.reduce((acc, p) => acc + projectFeePence(s, b, p.userId), 0);
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
function PersonRow({ s, b, p, onReceived, busy, proof, onSeeProof }: { s: Session; b: Bill; p: Participant; onReceived: (p: Participant) => void; busy: boolean; proof?: boolean; onSeeProof?: () => void }) {
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
      sub={
        <>
          {status ? `${status} · ${items}` : items}
          {proof ? <> · Sent a screenshot · <button type="button" className="link-btn" onClick={onSeeProof}>See screenshot</button></> : null}
        </>
      }
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

/**
 * L7 Settled (#217): where the lead stands. The bill, the platform fee, their
 * share, what nobody claimed (they covered it), what's come back from
 * friends and what's still to come, then who still owes, with *Received*:
 * guests can pay after. Numbers come from `billStatement`, as on *The whole
 * bill* and in the email.
 */
export function LeadSettled({ s, b }: { s: Session; b: Bill }) {
  const received = useReceived(s, b);
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const outstanding = guests.filter((p) => !isPaid(s, b, p));
  const st = billStatement(s, b, (p) => firstName(p.displayName, 'Guest'));
  const own = st.people.find((p) => p.status === 'lead')?.totalPence ?? 0;
  const back = guests.map((p) => ({ name: firstName(p.displayName, 'Guest'), pence: confirmedFor(s, b, p) })).filter((x) => x.pence > 0);
  const toCome = guests.reduce((acc, p) => acc + stillToCollect(s, b, p), 0);
  const spent = useSpent(s.sessionId);
  const fee = feeLine(spent);
  const feed = useTableFeed(s.participants, s.creatorUserId, (p) => owedFor(s, b, p));
  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <div className="vh" aria-live="polite" data-testid="table-feed">{feed}</div>
        <Title vt={billTitle(s.sessionId)} title={b.venue?.name ?? 'Your bill'} sub={<><Badge tone="ok">Settled</Badge> {formatDay(s.createdAt)}</>} aside={<BillTools sessionId={s.sessionId} billId={s.billId} showQr={false} />} />
        <Box>
          <Totals label="Where you stand">
            <TotalLine k="Bill" v={formatGBP(b.totalPence)} />
            {fee ? <TotalLine k={<>Platform fee{fee.sub ? <span className="totals__sub">{fee.sub}</span> : null}</>} v={fee.v} /> : null}
            <TotalLine k="Your share" v={formatGBP(own)} />
            {st.unclaimed.totalPence > 0 ? <TotalLine k="Nobody claimed · you covered" v={formatGBP(st.unclaimed.totalPence)} /> : null}
            <TotalLine tone="total" k={<>Back from friends{back.length > 0 ? <span className="totals__sub">{back.map((x) => `${x.name} ${formatGBP(x.pence)}`).join(' + ')}</span> : null}</>} v={formatGBP(st.receivedPence)} />
            {toCome > 0 ? <TotalLine tone="total" k="Still to come" v={formatGBP(toCome)} /> : null}
          </Totals>
        </Box>
        {outstanding.length > 0 ? (
          <Section title="Still to pay">
            <Box list>{outstanding.map((p) => (
              <PersonRow key={p.userId} s={s} b={b} p={p} onReceived={received.ask} busy={received.busy} />
            ))}</Box>
          </Section>
        ) : guests.length > 0 ? <Notice tone="ok" title="Everyone’s paid" /> : null}
        <div className="lead-links">
          <Link href={`/session/${s.sessionId}/summary`} className="link-btn">The whole bill</Link>
        </div>
      </Page>
      <ActionBar><Button grow href="/" replace>Done</Button></ActionBar>
      {received.sheet}
    </>
  );
}

/** The platform fee line on the settled bill, as built today (#167). */
function feeLine(spent: ReturnType<typeof useSpent>): { v: string; sub?: string } | null {
  if (spent.fee?.kind === 'hold') {
    if (spent.fee.capturedAt) return { v: `${formatGBP(spent.fee.capturedPence ?? 0)} from your hold`, sub: 'Your guests’ round-ups' };
    if (spent.fee.releasedAt) return { v: formatGBP(0), sub: 'Your hold is released' };
    return { v: `${formatGBP(spent.fee.amountPence)} hold`, sub: 'Settling it now' };
  }
  if (spent.fee) return { v: formatGBP(spent.fee.refundedAt ? 0 : spent.fee.amountPence), sub: spent.fee.refundedAt ? 'Refunded' : undefined };
  if (spent.credit) return { v: spent.credit.returnedAt ? 'Given back' : 'Free credit' };
  return null;
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
