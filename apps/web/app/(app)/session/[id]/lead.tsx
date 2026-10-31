'use client';

/**
 * The lead's side of a live bill: who's paid, what's still unclaimed, and
 * one way out ("Close the bill"). Everything updates on the session's
 * poll, so the lead can leave this open on the table.
 */
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, type components } from '@gdp/core/api';
import { useAbandonSession, useAddShare, useCloseSession, useRemoveShare, useSetClaims, useSetShareWays, useShareSession } from '@gdp/core/api/hooks/useSession';
import { useConfirmPayment } from '@gdp/core/api/hooks/usePaymentActions';
import { formatGBP } from '@gdp/core/lib/money';
import { projectOwedPence, sharePence } from '@gdp/core/lib/owed';
import { usePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import {
  Avatar, Back, Backdrop, Btn, Check, Fab, Faces, Hero, KV, Label, List, Notice, Paid, Price, QrIcon, Row, RowBody, Screen, Sheet, Tick, TopBar, firstName,
} from '@/components/glass';
import { PickRow, SplitSheet, Stepper, itemStatuses } from './guest';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];
type BillItem = components['schemas']['BillItem'];
type Share = NonNullable<Session['shares']>[number];

function owedFor(s: Session, b: Bill, p: Participant): number {
  return p.owedPence ?? projectOwedPence(s, b, p.userId);
}
const isPaid = (p: Participant) => p.payment.status === 'succeeded' || p.payment.status === 'self_paid';

/* ============================ setup ============================ */

export function LeadSetup({ s, b }: { s: Session; b: Bill }) {
  const router = useRouter();
  const share = useShareSession(s.sessionId);
  const payout = usePayoutAccount();
  const onShare = () => {
    if (!payout.data) { router.push(`/payout-account?returnTo=${encodeURIComponent(`/session/${s.sessionId}`)}`); return; }
    share.mutate(undefined, { onSuccess: () => router.replace(`/session/${s.sessionId}/share`) });
  };
  return (
    <Screen>
      <Backdrop billId={s.billId} tone="soft" />
      <TopBar left={<Fab href="/" label="Home" icon={<Back />} replace />} />
      <Sheet
        title={b.venue?.name ?? 'Your bill'}
        sub={`${b.items.length} items · ${formatGBP(b.totalPence)}`}
        foot={<Btn busy={share.isPending} onClick={onShare}>Share with the table</Btn>}
      >
        <Btn tone="ghost" href={`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`}>Fix the bill</Btn>
        {share.isError ? <Notice error>{share.error.message}</Notice> : null}
      </Sheet>
    </Screen>
  );
}

/* ============================ the table ============================ */

export function LeadTable({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const router = useRouter();
  const close = useCloseSession(s.sessionId);
  const abandon = useAbandonSession(s.sessionId);
  const confirm = useConfirmPayment(s.sessionId);
  const setClaims = useSetClaims(s.sessionId);
  const addShare = useAddShare(s.sessionId);
  const removeShare = useRemoveShare(s.sessionId);
  const setWays = useSetShareWays(s.sessionId);
  const [splitting, setSplitting] = useState<{ item: BillItem; ways: number; share?: Share } | null>(null);
  const [closing, setClosing] = useState(false);
  const [binning, setBinning] = useState(false);

  const me = s.participants.find((p) => p.userId === meUserId);
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const toCome = guests.reduce((acc, p) => (isPaid(p) ? acc : acc + owedFor(s, b, p)), 0);
  const paidCount = guests.filter(isPaid).length;
  const statuses = useMemo(() => itemStatuses(s, b, meUserId), [s, b, meUserId]);
  const unclaimed = statuses.filter((x) => x.left > 0);
  const unclaimedPence = unclaimed.reduce((acc, x) => acc + x.item.unitPricePence * x.left, 0);

  // Tapping an unclaimed item makes it the lead's. Tapping again hands it back.
  const takeOne = (itemId: string) => {
    if (!me) return;
    setClaims.mutate({ claimedItemIds: [...me.claimedItemIds, itemId] });
  };
  const dropOne = (itemId: string) => {
    if (!me) return;
    const next = [...me.claimedItemIds];
    const i = next.lastIndexOf(itemId);
    if (i < 0) return;
    next.splice(i, 1);
    setClaims.mutate({ claimedItemIds: next });
  };
  const hero = guests.length === 0
    ? <Hero title="Nobody’s joined yet" note="Show the QR" />
    : toCome > 0
      ? <Hero kicker="to come" amount={formatGBP(toCome)} note={`${paidCount} of ${guests.length} paid`} />
      : <Hero title="Everyone’s paid" note={unclaimed.length ? 'A few things are still unclaimed' : 'You can close the bill'} />;

  return (
    <Screen>
      <Backdrop billId={s.billId} tone="deep" />
      <TopBar
        left={<Fab href="/" label="Home" icon={<Back />} replace />}
        title={b.venue?.name}
        right={s.joinCode ? <Fab href={`/session/${s.sessionId}/share`} label="Show QR" icon={<QrIcon />} /> : undefined}
      />
      <Sheet
        size="tall"
        head={hero}
        foot={
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Btn onClick={() => setClosing(true)}>Close the bill</Btn>
            <Btn tone="ghost" href={`/confirm-bill/${s.billId}?sessionId=${s.sessionId}`}>Fix the bill</Btn>
          </div>
        }
      >
        {guests.length > 0 ? (
          <>
            <Label>Diners</Label>
            <List>
              {guests.map((p) => (
                <DinerLine key={p.userId} p={p} owed={owedFor(s, b, p)} onGotIt={p.payment.status === 'pending' ? () => confirm.mutate(p.payment.status === 'pending' ? p.payment.paymentId : '') : undefined} busy={confirm.isPending} />
              ))}
            </List>
            {confirm.isError ? <Notice error>{confirm.error.message}</Notice> : null}
          </>
        ) : null}

        <Label>{unclaimed.length > 0 ? `Unclaimed · ${formatGBP(unclaimedPence)}` : 'Everything’s claimed'}</Label>
        <List>
          {statuses.map(({ item, left, mine, who, share }) => {
            const others = who.filter((n) => n !== 'you');
            const name = item.quantity > 1 ? `${item.quantity}× ${item.name}` : item.name;
            if (share) {
              // A split: anyone can join, the lead included. Tick = in it.
              const inIt = share.userIds.includes(meUserId);
              const seats = Math.max(0, share.ways - share.userIds.length);
              const myWays = inIt || seats > 0 ? share.ways : share.ways + 1;
              const people = share.userIds.map((uid) => s.participants.find((p) => p.userId === uid)).filter((p): p is Participant => !!p);
              return (
                <PickRow
                  key={item.itemId}
                  on={inIt}
                  busy={addShare.isPending || removeShare.isPending}
                  label={inIt ? `Leave the split for ${item.name}` : `Join the split for ${item.name}`}
                  onTap={() => (inIt ? removeShare.mutate({ itemId: item.itemId }) : addShare.mutate({ itemId: item.itemId }))}
                  name={name}
                  sub={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Faces people={people.map((p) => ({ name: p.displayName, seed: p.userId }))} spare={seats} /> {share.ways} ways</span>}
                  price={<Price mute={!inIt} note="each">{formatGBP(sharePence(item.unitPricePence, share.userIds, myWays, meUserId))}</Price>}
                  aside={inIt ? <button type="button" className="g-mini-btn" onClick={() => setSplitting({ item, ways: share.ways, share })} aria-label={`Change how many ways ${item.name} is split`}>{share.ways}</button> : undefined}
                />
              );
            }
            if (mine > 0 && item.quantity > 1) {
              // Yours, more than one on the line: a − n + stepper, so you
              // can go from 3 to 0 and not just bounce between 3 and 2.
              return (
                <div key={item.itemId} className="g-row g-row--on" style={{ gap: 10 }}>
                  <Check on />
                  <RowBody name={name} sub={others.length ? `${others.join(', ')} · ${formatGBP(item.unitPricePence)} each` : `${formatGBP(item.unitPricePence)} each`} />
                  <Stepper n={mine} max={mine + left} busy={setClaims.isPending} onDec={() => dropOne(item.itemId)} onInc={() => takeOne(item.itemId)} name={item.name} />
                  <Price>{formatGBP(item.unitPricePence * mine)}</Price>
                </div>
              );
            }
            if (left > 0 && item.quantity === 1) {
              // Still open: tap takes it, or split it with the table.
              return (
                <PickRow
                  key={item.itemId}
                  busy={setClaims.isPending}
                  label={`Take ${item.name}`}
                  onTap={() => takeOne(item.itemId)}
                  name={name}
                  price={<Price>{formatGBP(item.unitPricePence)}</Price>}
                  aside={<button type="button" className="g-mini-btn" onClick={() => setSplitting({ item, ways: 2 })} aria-label={`Split ${item.name}`}>Split</button>}
                />
              );
            }
            if (left > 0) {
              // Still open: tap takes one for the lead.
              const sub = [others.length ? others.join(', ') : null, item.quantity > 1 ? `${left} left · ${formatGBP(item.unitPricePence)} each` : null].filter(Boolean).join(' · ');
              return (
                <Row key={item.itemId} onClick={() => takeOne(item.itemId)} disabled={setClaims.isPending} ariaLabel={`Take ${item.name}`}>
                  <Check on={false} />
                  <RowBody name={name} sub={sub || undefined} />
                  <Price>{formatGBP(item.unitPricePence * left)}</Price>
                </Row>
              );
            }
            if (mine > 0) {
              // Yours: tap hands it back.
              return (
                <Row key={item.itemId} on onClick={() => dropOne(item.itemId)} disabled={setClaims.isPending} ariaLabel={`Hand back ${item.name}`}>
                  <Check on />
                  <RowBody name={name} sub="you" />
                  <Price>{formatGBP(item.unitPricePence)}</Price>
                </Row>
              );
            }
            // Someone else's: stays put, just dims.
            return (
              <div key={item.itemId} className="g-row g-row--done">
                <span className="g-check g-check--done" aria-hidden><Tick size={14} /></span>
                <RowBody name={name} sub={others.join(', ')} />
                <Price mute>{formatGBP(item.unitPricePence * item.quantity)}</Price>
              </div>
            );
          })}
        </List>
        {unclaimed.length > 0 ? <p className="g-foot-note">Tap to take one yourself. Anything left is yours when you close.</p> : null}
        {setClaims.isError ? <Notice error>{setClaims.error.message}</Notice> : null}
        {addShare.isError ? <Notice error>{addShare.error.message}</Notice> : null}
        {removeShare.isError ? <Notice error>{removeShare.error.message}</Notice> : null}

        <List>
          <KV k="Bill" v={formatGBP(b.totalPence)} />
          <KV k="Paid to you" v={formatGBP(guests.reduce((acc, p) => (isPaid(p) ? acc + owedFor(s, b, p) : acc), 0))} />
        </List>
        <button type="button" className="g-btn g-btn--ghost g-btn--sm" style={{ color: 'var(--g-mute)' }} onClick={() => setBinning(true)}>Bin this bill</button>
      </Sheet>

      {splitting ? (
        <SplitSheet
          item={splitting.item}
          ways={splitting.ways}
          min={Math.max(2, splitting.share?.userIds.length ?? 1)}
          busy={addShare.isPending || setWays.isPending}
          error={setWays.error instanceof ApiError ? setWays.error.message : undefined}
          onChange={(ways) => setSplitting({ ...splitting, ways })}
          onCancel={() => { setSplitting(null); setWays.reset(); }}
          onOk={() => {
            const done = () => setSplitting(null);
            if (splitting.share) setWays.mutate({ itemId: splitting.item.itemId, ways: splitting.ways }, { onSuccess: done });
            else addShare.mutate({ itemId: splitting.item.itemId, ways: splitting.ways }, { onSuccess: done });
          }}
        />
      ) : null}
      {closing ? (
        <Confirm
          title="Close the bill?"
          body={[
            unclaimedPence > 0 ? `${formatGBP(unclaimedPence)} unclaimed goes on you.` : null,
            toCome > 0 ? `${formatGBP(toCome)} still to come — they can still pay.` : null,
          ].filter(Boolean).join(' ') || 'Everyone has paid.'}
          ok="Close"
          busy={close.isPending}
          error={close.error?.message}
          onOk={() => close.mutate(undefined, { onSuccess: () => setClosing(false) })}
          onCancel={() => setClosing(false)}
        />
      ) : null}
      {binning ? (
        <Confirm
          title="Bin this bill?"
          body={guests.length > 0 ? `${guests.length} ${guests.length === 1 ? 'person loses' : 'people lose'} their picks. No undo.` : 'No undo.'}
          ok="Bin it"
          danger
          busy={abandon.isPending}
          error={abandon.error?.message}
          onOk={() => abandon.mutate(undefined, { onSuccess: () => router.replace('/') })}
          onCancel={() => setBinning(false)}
        />
      ) : null}
    </Screen>
  );
}

function DinerLine({ p, owed, onGotIt, busy }: { p: Participant; owed: number; onGotIt?: () => void; busy: boolean }) {
  const saysPaid = p.payment.status === 'pending' && !!p.payment.payerClaimedPaidAt;
  return (
    <div className="g-row" style={{ gap: 12 }}>
      <Avatar name={p.displayName} seed={p.userId} size={32} />
      <RowBody
        name={firstName(p.displayName)}
        sub={isPaid(p) ? undefined : saysPaid ? 'says they’ve sent it' : p.payment.status === 'pending' ? 'paying' : 'not yet'}
      />
      {isPaid(p) ? (
        <Paid>{formatGBP(owed)}</Paid>
      ) : saysPaid && onGotIt ? (
        <button type="button" className="g-mini-btn g-mini-btn--solid" onClick={onGotIt} disabled={busy} aria-label={`Confirm ${firstName(p.displayName)} paid ${formatGBP(owed)}`}>
          <Tick size={12} /> Got it
        </button>
      ) : (
        <Price mute>{formatGBP(owed)}</Price>
      )}
    </div>
  );
}

/* ============================ settled ============================ */

export function LeadSettled({ s, b }: { s: Session; b: Bill }) {
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const outstanding = guests.filter((p) => !isPaid(p));
  const collected = guests.reduce((acc, p) => (isPaid(p) ? acc + owedFor(s, b, p) : acc), 0);
  return (
    <Screen>
      <Backdrop billId={s.billId} tone="deep" />
      <TopBar left={<Fab href="/" label="Home" icon={<Back />} replace />} title={b.venue?.name} />
      <Sheet
        head={
          <div className="g-sheet__head" style={{ alignItems: 'center', textAlign: 'center' }}>
            <div className="g-done g-rise"><Tick size={40} /></div>
            <Hero kicker="back in your account" amount={formatGBP(collected)} note={outstanding.length === 0 ? 'Bill closed' : `${outstanding.length} still to pay`} />
          </div>
        }
        foot={<Btn href="/" replace>Done</Btn>}
      >
        {guests.length > 0 ? (
          <List>
            {guests.map((p) => (
              <div key={p.userId} className="g-row" style={{ gap: 12 }}>
                <Avatar name={p.displayName} seed={p.userId} size={32} />
                <RowBody name={firstName(p.displayName)} />
                {isPaid(p) ? <Paid>{formatGBP(owedFor(s, b, p))}</Paid> : <Price mute>{formatGBP(owedFor(s, b, p))}</Price>}
              </div>
            ))}
          </List>
        ) : null}
        <List>
          <KV k="Bill" v={formatGBP(b.totalPence)} />
          <KV k="Your part" v={formatGBP(Math.max(0, b.totalPence - guests.reduce((acc, p) => acc + owedFor(s, b, p), 0)))} />
        </List>
      </Sheet>
    </Screen>
  );
}

/* ============================ ended ============================ */

export function Ended({ s, isCreator }: { s: Session; isCreator: boolean }) {
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  return (
    <Screen>
      <Backdrop tone="deep" />
      <Sheet title="This bill was binned" sub={isCreator ? 'You can start again from the same photo.' : `${firstName(host?.displayName)} ended it.`} foot={<Btn href="/" replace>Home</Btn>} />
    </Screen>
  );
}

/* ============================ bits ============================ */

function Confirm({ title, body, ok, danger, busy, error, onOk, onCancel }: {
  title: string; body: string; ok: string; danger?: boolean; busy: boolean; error?: string; onOk: () => void; onCancel: () => void;
}) {
  return (
    <>
      <div className="g-overlay" onClick={onCancel} aria-hidden />
      {/* Full-screen, click-through layer so the dialog has a real box (for
          assistive tech and tests) while taps outside the sheet reach the overlay. */}
      <div role="dialog" aria-modal="true" aria-labelledby="g-confirm-t" style={{ position: 'fixed', inset: 0, zIndex: 50, pointerEvents: 'none' }}>
        <Sheet
          className="g-sheet--solid"
          title={<span id="g-confirm-t">{title}</span>}
          sub={body}
          foot={
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Btn tone={danger ? 'danger' : 'accent'} busy={busy} onClick={onOk}>{ok}</Btn>
              <Btn tone="ghost" onClick={onCancel}>Not yet</Btn>
            </div>
          }
        >
          {error ? <Notice error>{error}</Notice> : null}
        </Sheet>
      </div>
    </>
  );
}
