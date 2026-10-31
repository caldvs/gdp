'use client';

/**
 * The guest's side: tick what you had (Pick), then watch the table until
 * the lead closes the bill (GuestTable). Pay lives in ./pay.
 */
import { useMemo, useState } from 'react';
import { ApiError, type components } from '@gdp/core/api';
import { useAddShare, useRemoveShare, useSetClaims, useSetShareWays } from '@gdp/core/api/hooks/useSession';
import { formatGBP } from '@gdp/core/lib/money';
import { extrasRate as billExtrasRate, projectOwedPence, projectSubtotalPence, sharePence } from '@gdp/core/lib/owed';
import {
  Avatar, Back, Backdrop, Btn, Check, Fab, Faces, Hero, KV, Label, List, Notice, Paid, Price, RowBody, Screen, Sheet, Tick, TopBar, firstName,
} from '@/components/glass';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];
type BillItem = components['schemas']['BillItem'];
type Share = NonNullable<Session['shares']>[number];

const isPaid = (p: Participant) => p.payment.status === 'succeeded' || p.payment.status === 'self_paid';

/**
 * Every bill line in bill order with who has it, so lists keep their shape
 * while people claim: a row changes state instead of vanishing.
 */
export type ItemStatus = { item: BillItem; left: number; mine: number; who: string[]; share?: Share };
export function itemStatuses(s: Session, b: Bill, meUserId: string): ItemStatus[] {
  const taken = new Map<string, number>();
  const mine = new Map<string, number>();
  const who = new Map<string, string[]>();
  const add = (id: string, p: Participant) => {
    taken.set(id, (taken.get(id) ?? 0) + 1);
    if (p.userId === meUserId) mine.set(id, (mine.get(id) ?? 0) + 1);
    const l = who.get(id) ?? [];
    const n = p.userId === meUserId ? 'you' : firstName(p.displayName);
    if (!l.includes(n)) l.push(n);
    who.set(id, l);
  };
  for (const p of s.participants) for (const id of p.claimedItemIds) add(id, p);
  for (const sh of s.shares ?? []) {
    if (sh.userIds.length === 0) continue;
    taken.set(sh.itemId, (taken.get(sh.itemId) ?? 0) + 1);
    const names = sh.userIds.map((uid) => (uid === meUserId ? 'you' : firstName(s.participants.find((p) => p.userId === uid)?.displayName)));
    who.set(sh.itemId, [...(who.get(sh.itemId) ?? []), ...names]);
    if (sh.userIds.includes(meUserId)) mine.set(sh.itemId, (mine.get(sh.itemId) ?? 0) + 1);
  }
  return b.items.map((item) => {
    const share = s.shares?.find((x) => x.itemId === item.itemId && x.userIds.length > 0);
    return { item, left: Math.max(0, item.quantity - (taken.get(item.itemId) ?? 0)), mine: mine.get(item.itemId) ?? 0, who: who.get(item.itemId) ?? [], ...(share ? { share } : {}) };
  });
}

/** A read-only bill line: open (nobody's yet), done (someone's), or yours. */
export function ItemLine({ st }: { st: ItemStatus }) {
  const { item, left, mine, who, share } = st;
  const open = left > 0;
  const name = item.quantity > 1 ? `${item.quantity}× ${item.name}` : item.name;
  const seats = share ? Math.max(0, share.ways - share.userIds.length) : 0;
  const sub = share
    ? `${who.join(', ')} · split ${share.ways} ways${seats ? ` · ${seats} seat${seats === 1 ? '' : 's'} open` : ''}`
    : who.length > 0 ? `${who.join(', ')}${open ? ` · ${left} left` : ''}` : undefined;
  return (
    <div className={`g-row${!open && mine === 0 ? ' g-row--done' : ''}${mine > 0 && !open ? ' g-row--on' : ''}`}>
      {open ? <Check on={false} /> : <span className={`g-check${mine > 0 ? ' g-check--on' : ' g-check--done'}`} aria-hidden><Tick size={14} /></span>}
      <RowBody name={name} sub={sub} />
      {share ? (
        <Price mute={mine === 0} note="each">{formatGBP(sharePence(item.unitPricePence, share.userIds, share.ways, ''))}</Price>
      ) : (
        <Price mute={open || mine === 0}>{formatGBP(item.unitPricePence * (mine > 0 ? mine : item.quantity))}</Price>
      )}
    </div>
  );
}
export const owedFor = (s: Session, b: Bill, p: Participant) => p.owedPence ?? projectOwedPence(s, b, p.userId);

function useCounts(s: Session, meUserId: string) {
  return useMemo(() => {
    const mine = new Map<string, number>();
    const others = new Map<string, number>();
    const who = new Map<string, Participant[]>();
    for (const p of s.participants) {
      for (const id of p.claimedItemIds) {
        if (p.userId === meUserId) mine.set(id, (mine.get(id) ?? 0) + 1);
        else {
          others.set(id, (others.get(id) ?? 0) + 1);
          const l = who.get(id) ?? [];
          if (!l.some((x) => x.userId === p.userId)) l.push(p);
          who.set(id, l);
        }
      }
    }
    return { mine, others, who };
  }, [s, meUserId]);
}

function shareError(err: ApiError): string {
  if (err.code === 'SHARE_PAID') return 'Someone in this split has paid, so it can’t change.';
  if (err.code === 'SHARE_WAYS_TOO_LOW') return 'More people are in it already.';
  return err.message;
}

/* ============================ pick ============================ */

export function GuestPick({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const setClaims = useSetClaims(s.sessionId);
  const addShare = useAddShare(s.sessionId);
  const removeShare = useRemoveShare(s.sessionId);
  const setWays = useSetShareWays(s.sessionId);
  const [splitting, setSplitting] = useState<{ item: BillItem; ways: number; share?: Share } | null>(null);

  const me = s.participants.find((p) => p.userId === meUserId);
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = firstName(host?.displayName);
  const counts = useCounts(s, meUserId);
  const subtotal = projectSubtotalPence(s, b, meUserId);
  const rate = billExtrasRate(b);
  const owed = Math.round(subtotal * (1 + rate));
  const busy = setClaims.isPending || addShare.isPending || removeShare.isPending;

  const claimOne = (item: BillItem) => {
    if (!me) return;
    setClaims.mutate({ claimedItemIds: [...me.claimedItemIds, item.itemId] });
  };
  const dropOne = (itemId: string) => {
    if (!me) return;
    const next = [...me.claimedItemIds];
    const i = next.lastIndexOf(itemId);
    if (i < 0) return;
    next.splice(i, 1);
    setClaims.mutate({ claimedItemIds: next });
  };

  const err = setClaims.error?.message ?? (addShare.error ? shareError(addShare.error) : undefined) ?? removeShare.error?.message;

  return (
    <Screen>
      <Backdrop billId={s.billId} tone="deep" />
      <TopBar left={<Fab href="/" label="Home" icon={<Back />} replace />} title={b.venue?.name} />
      <Sheet
        size="tall"
        title="What did you have?"
        sub={`${hostFirst}’s bill · ${formatGBP(b.totalPence)}`}
        foot={
          <>
            <Btn href={`/session/${s.sessionId}/pay`} disabled={owed <= 0 || busy}>
              {owed > 0 ? `Pay ${hostFirst} ${formatGBP(owed)}` : 'Tick what you had'}
            </Btn>
            {owed > 0 && rate > 0 ? <p className="g-foot-note">{formatGBP(subtotal)} + service</p> : null}
          </>
        }
      >
        <List>
          {b.items.map((item) => {
            const mine = counts.mine.get(item.itemId) ?? 0;
            const others = counts.others.get(item.itemId) ?? 0;
            const left = item.quantity - mine - others;
            const share = s.shares?.find((x) => x.itemId === item.itemId);
            const inShare = !!share?.userIds.includes(meUserId);

            if (share && share.userIds.length > 0) {
              const openSeats = Math.max(0, share.ways - share.userIds.length);
              const myWays = inShare || openSeats > 0 ? share.ways : share.ways + 1;
              const each = sharePence(item.unitPricePence, share.userIds, myWays, meUserId);
              const people = share.userIds.map((uid) => s.participants.find((p) => p.userId === uid)).filter((p): p is Participant => !!p);
              return (
                <PickRow
                  key={item.itemId}
                  on={inShare}
                  busy={busy}
                  label={inShare ? `Leave the split for ${item.name}` : `Join the split for ${item.name}`}
                  onTap={() => (inShare ? removeShare.mutate({ itemId: item.itemId }) : addShare.mutate({ itemId: item.itemId }))}
                  name={item.name}
                  sub={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Faces people={people.map((p) => ({ name: p.displayName, seed: p.userId }))} spare={openSeats} /> {share.ways} ways</span>}
                  price={<Price note="each">{formatGBP(each)}</Price>}
                  aside={inShare ? <button type="button" className="g-mini-btn" onClick={() => setSplitting({ item, ways: share.ways, share })} aria-label={`Change how many ways ${item.name} is split`}>{share.ways}</button> : undefined}
                />
              );
            }

            if (mine === 0 && left === 0) {
              const names = (counts.who.get(item.itemId) ?? []).map((p) => firstName(p.displayName)).join(', ');
              return (
                <PickRow key={item.itemId} taken name={item.quantity > 1 ? `${item.quantity}× ${item.name}` : item.name} sub={names} price={<Price mute>{formatGBP(item.unitPricePence * item.quantity)}</Price>} />
              );
            }

            if (item.quantity > 1) {
              return (
                <PickRow
                  key={item.itemId}
                  on={mine > 0}
                  busy={busy}
                  label={mine > 0 ? `${item.name}: ${mine} of ${item.quantity}` : `Take one ${item.name}`}
                  onTap={mine > 0 ? undefined : () => claimOne(item)}
                  name={`${item.quantity}× ${item.name}`}
                  sub={others > 0 && mine === 0 ? `${others} taken · ${formatGBP(item.unitPricePence)} each` : `${formatGBP(item.unitPricePence)} each`}
                  price={<Price mute={mine === 0}>{formatGBP(item.unitPricePence * (mine || 1))}</Price>}
                  aside={mine > 0 ? (
                    <Stepper n={mine} max={mine + left} busy={busy} onDec={() => dropOne(item.itemId)} onInc={() => claimOne(item)} name={item.name} />
                  ) : undefined}
                />
              );
            }

            return (
              <PickRow
                key={item.itemId}
                on={mine > 0}
                busy={busy}
                label={mine > 0 ? `Untick ${item.name}` : `Tick ${item.name}`}
                onTap={() => (mine > 0 ? dropOne(item.itemId) : claimOne(item))}
                name={item.name}
                price={<Price mute={mine === 0}>{formatGBP(item.unitPricePence)}</Price>}
                aside={mine === 0 ? <button type="button" className="g-mini-btn" onClick={() => setSplitting({ item, ways: 2 })} aria-label={`Split ${item.name}`}>Split</button> : undefined}
              />
            );
          })}
        </List>
        {err ? <Notice error>{err}</Notice> : null}
      </Sheet>

      {splitting ? (
        <SplitSheet
          item={splitting.item}
          ways={splitting.ways}
          min={Math.max(2, splitting.share?.userIds.length ?? 1)}
          busy={addShare.isPending || setWays.isPending}
          error={setWays.error ? shareError(setWays.error) : undefined}
          onChange={(ways) => setSplitting({ ...splitting, ways })}
          onCancel={() => { setSplitting(null); setWays.reset(); }}
          onOk={() => {
            const done = () => setSplitting(null);
            if (splitting.share) setWays.mutate({ itemId: splitting.item.itemId, ways: splitting.ways }, { onSuccess: done });
            else addShare.mutate({ itemId: splitting.item.itemId, ways: splitting.ways }, { onSuccess: done });
          }}
        />
      ) : null}
    </Screen>
  );
}

/** A tick row with an optional control on the right that isn't part of the tap target. */
export function PickRow({ on, taken, busy, label, onTap, name, sub, price, aside }: {
  on?: boolean; taken?: boolean; busy?: boolean; label?: string; onTap?: () => void; name: string; sub?: React.ReactNode; price: React.ReactNode; aside?: React.ReactNode;
}) {
  const cls = ['g-row', on && 'g-row--on', taken && 'g-row--taken'].filter(Boolean).join(' ');
  const body = (
    <>
      <Check on={!!on} />
      <RowBody name={name} sub={sub} />
      {aside ? null : price}
    </>
  );
  return (
    <div className={cls} style={{ padding: 0 }}>
      {onTap ? (
        <button type="button" className="g-row" style={{ flex: 1, minWidth: 0, background: 'none', border: 0, color: 'inherit', font: 'inherit', textAlign: 'left' }} onClick={onTap} disabled={busy} aria-pressed={!!on} aria-label={label}>
          {body}
        </button>
      ) : (
        <div className="g-row" style={{ flex: 1, minWidth: 0, background: 'none' }}>{body}</div>
      )}
      {aside ? <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingRight: 14, flex: 'none' }}>{aside}{price}</div> : null}
    </div>
  );
}

export function Stepper({ n, max, busy, onDec, onInc, name }: { n: number; max: number; busy: boolean; onDec: () => void; onInc: () => void; name: string }) {
  const b = { border: 0, width: 32, padding: 0, fontSize: 18 } as const;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', background: 'var(--g-fill-2)', borderRadius: 16, height: 32 }}>
      <button type="button" className="g-mini-btn" style={b} aria-label={`One fewer ${name}`} disabled={busy} onClick={onDec}>−</button>
      <span style={{ minWidth: 16, textAlign: 'center', fontSize: 14, fontWeight: 700 }} aria-live="polite">{n}</span>
      <button type="button" className="g-mini-btn" style={b} aria-label={`One more ${name}`} disabled={busy || n >= max} onClick={onInc}>+</button>
    </span>
  );
}

export function SplitSheet({ item, ways, min, busy, error, onChange, onCancel, onOk }: {
  item: BillItem; ways: number; min: number; busy: boolean; error?: string; onChange: (n: number) => void; onCancel: () => void; onOk: () => void;
}) {
  return (
    <>
      <div className="g-overlay" onClick={onCancel} aria-hidden />
      <div role="dialog" aria-modal="true" style={{ position: 'fixed', inset: 'auto 0 0 0', zIndex: 50 }}>
        <Sheet
          className="g-sheet--solid"
          title={`Split ${item.name}`}
          sub={formatGBP(item.unitPricePence)}
          foot={
            <>
              <Btn busy={busy} onClick={onOk}>{formatGBP(Math.ceil(item.unitPricePence / ways))} each</Btn>
              <Btn tone="ghost" onClick={onCancel}>Cancel</Btn>
            </>
          }
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 20, padding: '6px 0' }}>
            <button type="button" className="g-fab g-fab--icon" style={{ width: 52, height: 52, borderRadius: 26, fontSize: 24 }} aria-label="Fewer people" disabled={ways <= min} onClick={() => onChange(ways - 1)}>−</button>
            <span style={{ fontSize: 40, fontWeight: 700, minWidth: 56, textAlign: 'center' }} aria-live="polite">{ways}</span>
            <button type="button" className="g-fab g-fab--icon" style={{ width: 52, height: 52, borderRadius: 26, fontSize: 24 }} aria-label="More people" disabled={ways >= 20} onClick={() => onChange(ways + 1)}>+</button>
          </div>
          <p className="g-foot-note">people, including you</p>
          {error ? <Notice error>{error}</Notice> : null}
        </Sheet>
      </div>
    </>
  );
}

/* ============================ the table (guest) ============================ */

export function GuestTable({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const me = s.participants.find((p) => p.userId === meUserId);
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = firstName(host?.displayName);
  const guests = s.participants.filter((p) => p.userId !== s.creatorUserId);
  const closed = s.status === 'settled';
  const statuses = useMemo(() => itemStatuses(s, b, meUserId), [s, b, meUserId]);
  const openCount = statuses.filter((x) => x.left > 0).length;

  const myOwed = me ? owedFor(s, b, me) : 0;
  const status = me?.payment.status;
  const hero = status === 'succeeded'
    ? <Hero kicker={`${hostFirst} has your`} amount={formatGBP(myOwed)} />
    : status === 'pending' && me?.payment.status === 'pending' && me.payment.payerClaimedPaidAt
      ? <Hero kicker={`sent to ${hostFirst}`} amount={formatGBP(myOwed)} note={`Waiting for ${hostFirst} to confirm`} />
      : closed
        ? <Hero kicker={`you owe ${hostFirst}`} amount={formatGBP(myOwed)} />
        : null;

  return (
    <Screen>
      <Backdrop billId={s.billId} tone="deep" />
      <TopBar left={<Fab href="/" label="Home" icon={<Back />} replace />} title={b.venue?.name} />
      <Sheet
        size="tall"
        head={hero ? <div className="g-sheet__head">{hero}</div> : undefined}
        foot={
          closed && status !== 'succeeded' && status !== 'pending' && myOwed > 0
            ? <Btn href={`/session/${s.sessionId}/pay`}>Pay {hostFirst} {formatGBP(myOwed)}</Btn>
            : <Btn tone={closed ? 'accent' : 'ghost'} href="/" replace>{closed ? 'Done' : 'Close'}</Btn>
        }
      >
        {!closed ? (
          <>
            <Label>{openCount > 0 ? `${openCount} still unclaimed` : 'Everything’s claimed'}</Label>
            <List>
              {statuses.map((st) => <ItemLine key={st.item.itemId} st={st} />)}
            </List>
            {openCount > 0 ? <p className="g-foot-note">One of these yours? Tell {hostFirst}.</p> : null}
          </>
        ) : null}

        <Label>{closed ? 'Bill closed' : 'Who’s paid'}</Label>
        <List>
          {guests.map((p) => {
            const saysPaid = p.payment.status === 'pending' && !!p.payment.payerClaimedPaidAt;
            return (
              <div key={p.userId} className="g-row" style={{ gap: 12 }}>
                <Avatar name={p.displayName} seed={p.userId} size={32} />
                <RowBody name={p.userId === meUserId ? 'You' : firstName(p.displayName)} sub={isPaid(p) ? undefined : saysPaid ? 'sent' : 'not yet'} />
                {isPaid(p) ? <Paid>{formatGBP(owedFor(s, b, p))}</Paid> : <Price mute>{formatGBP(owedFor(s, b, p))}</Price>}
              </div>
            );
          })}
        </List>
        {!closed ? <p className="g-foot-note">Waiting for {hostFirst} to close the bill</p> : null}

        {me && (me.claimedItemIds.length > 0 || me.sharedItemIds.length > 0) ? (
          <>
            <Label>You had</Label>
            <List>
              {[...new Set(me.claimedItemIds)].map((id) => {
                const item = b.items.find((x) => x.itemId === id);
                if (!item) return null;
                const n = me.claimedItemIds.filter((x) => x === id).length;
                return <KV key={id} k={n > 1 ? `${n}× ${item.name}` : item.name} v={formatGBP(item.unitPricePence * n)} />;
              })}
              {me.sharedItemIds.map((id) => {
                const item = b.items.find((x) => x.itemId === id);
                const share = s.shares?.find((x) => x.itemId === id);
                if (!item || !share) return null;
                return <KV key={id} k={`${item.name} · split ${share.ways}`} v={formatGBP(sharePence(item.unitPricePence, share.userIds, share.ways, meUserId))} />;
              })}
              <KV k="Your total" v={formatGBP(myOwed)} total />
            </List>
          </>
        ) : null}
        {closed && status === 'succeeded' ? <div style={{ display: 'flex', justifyContent: 'center', padding: 8 }}><div className="g-done g-rise"><Tick size={36} /></div></div> : null}
      </Sheet>
    </Screen>
  );
}
