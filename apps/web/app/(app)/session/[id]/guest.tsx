'use client';

/**
 * The guest's side: tick what you had (Pick), then see where things
 * stand until the lead closes the bill (GuestTable). Pay lives in ./pay.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type components } from '@gdp/core/api';
import { useAddShare, useRemoveShare, useSetClaims, useSetShareWays } from '@gdp/core/api/hooks/useSession';
import { formatGBP } from '@gdp/core/lib/money';
import { itemStatuses as coreItemStatuses, type ItemStatus } from '@gdp/core/lib/leftovers';
import { extrasRate as billExtrasRate, projectOwedPence, projectSubtotalPence, sharePence } from '@gdp/core/lib/owed';
import {
  ActionBar, AvatarStack, BackLink, Box, Button, Dialog, Notice, Page, Row, Section, TickIcon, Title, TotalLine, Totals, firstName,
} from '@/components/ui';
import { BillTools } from '@/components/BillTools';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];
type BillItem = components['schemas']['BillItem'];
type Share = NonNullable<Session['shares']>[number];

const isPaid = (p: Participant) => p.payment.status === 'succeeded' || p.payment.status === 'self_paid';

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
  const sub = share
    ? `Shared ${share.ways} ways${seats ? ` · ${seats} open` : ''}`
    : open && who.length > 0 ? `${left} left` : undefined;
  const price = share
    ? formatGBP(sharePence(item.unitPricePence, share.userIds, share.ways, ''))
    : formatGBP(item.unitPricePence * (mine > 0 ? mine : open ? left : item.quantity));
  return <Row title={name} sub={sub} end={price} muted={!open && mine === 0} lead={who.length > 0 ? <AvatarStack names={who} /> : undefined} />;
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

type Change = { text: string };

/**
 * #123: when a row changes because of someone ELSE — claimed, partly
 * claimed, or joined a split — say what happened instead of letting the
 * row just reflow or vanish. Diffs this poll's statuses against the last
 * one; a row where *my* claim count didn't move but something else about
 * it did is someone else's doing. Fires at most once per poll (session
 * polling is already throttled to a few seconds), and the whole batch
 * clears after ~2s so rows settle back to their steady state.
 */
export function useChangeFeed(statuses: ItemStatus[]) {
  const prevRef = useRef<Map<string, { left: number; mine: number; who: string[]; shareWays: number }> | null>(null);
  const [changes, setChanges] = useState<Map<string, Change>>(new Map());

  useEffect(() => {
    const prev = prevRef.current;
    const next = new Map<string, { left: number; mine: number; who: string[]; shareWays: number }>();
    const batch = new Map<string, Change>();
    for (const st of statuses) {
      const id = st.item.itemId;
      const shareWays = st.share?.userIds.length ?? 0;
      next.set(id, { left: st.left, mine: st.mine, who: st.who, shareWays });
      const was = prev?.get(id);
      if (!was || was.mine !== st.mine) continue; // first poll, or my own claim moved
      const newcomer = st.who.filter((w) => w !== 'you').find((w) => !was.who.includes(w));
      if (!newcomer) continue;
      if (shareWays > was.shareWays) batch.set(id, { text: `Split with ${newcomer}` });
      else if (st.left < was.left) batch.set(id, { text: st.left === 0 ? `${newcomer} took it` : `${st.item.quantity - st.left} of ${st.item.quantity} left` });
    }
    prevRef.current = next;
    if (batch.size > 0) {
      setChanges(batch);
      const t = setTimeout(() => setChanges(new Map()), 2000);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [statuses]);

  const liveText = useMemo(() => [...changes.values()].map((c) => c.text).join('. '), [changes]);
  return { changes, liveText };
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
  // #123: an item a tap just lost the race for (someone else got there first).
  const [raceLostItemId, setRaceLostItemId] = useState<string | null>(null);
  const [hideTaken, setHideTaken] = useState(false);

  const me = s.participants.find((p) => p.userId === meUserId);
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = firstName(host?.displayName);
  const counts = useCounts(s, meUserId);
  const statuses = useMemo(() => itemStatuses(s, b, meUserId), [s, b, meUserId]);
  const { changes, liveText } = useChangeFeed(statuses);
  const open = statuses.filter((x) => x.left > 0);
  const leftPence = open.reduce((acc, x) => acc + x.item.unitPricePence * x.left, 0);
  const subtotal = projectSubtotalPence(s, b, meUserId);
  const rate = billExtrasRate(b);
  const owed = Math.round(subtotal * (1 + rate));
  const busy = setClaims.isPending || addShare.isPending || removeShare.isPending;

  const claimOne = (item: BillItem) => {
    if (!me) return;
    setRaceLostItemId(null);
    setClaims.mutate(
      { claimedItemIds: [...me.claimedItemIds, item.itemId] },
      {
        onError: (e) => {
          const itemId = e instanceof ApiError ? (e.details as { itemId?: string } | undefined)?.itemId : undefined;
          if (e instanceof ApiError && e.code === 'SESSION_INVALID_STATE' && itemId === item.itemId) {
            setRaceLostItemId(item.itemId);
          }
        },
      },
    );
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

  const rows = b.items.map((item) => {
    const mine = counts.mine.get(item.itemId) ?? 0;
    const others = counts.others.get(item.itemId) ?? 0;
    const left = item.quantity - mine - others;
    const share = s.shares?.find((x) => x.itemId === item.itemId);
    const inShare = !!share?.userIds.includes(meUserId);
    const change = changes.get(item.itemId);

    if (share && share.userIds.length > 0) {
      const openSeats = Math.max(0, share.ways - share.userIds.length);
      const myWays = inShare || openSeats > 0 ? share.ways : share.ways + 1;
      const each = sharePence(item.unitPricePence, share.userIds, myWays, meUserId);
      return {
        taken: false,
        el: (
          <PickRow
            key={item.itemId}
            on={inShare}
            changed={!!change}
            busy={busy}
            action={inShare ? 'Leave the split for' : 'Join the split for'}
            onTap={() => (inShare ? removeShare.mutate({ itemId: item.itemId }) : addShare.mutate({ itemId: item.itemId }))}
            name={item.name}
            sub={change?.text ?? splitSub(s, share, meUserId)}
            price={<>{formatGBP(each)}<span className="each">each</span></>}
            aside={inShare ? <Button tone="text" small onClick={() => setSplitting({ item, ways: share.ways, share })} aria-label={`Change how many ways ${item.name} is split`}>{share.ways} ways</Button> : undefined}
          />
        ),
      };
    }

    if (mine === 0 && left === 0) {
      const names = (counts.who.get(item.itemId) ?? []).map((p) => firstName(p.displayName));
      const justTaken = raceLostItemId === item.itemId;
      const name = item.quantity > 1 ? `${item.name} × ${item.quantity}` : item.name;
      return {
        taken: true,
        el: (
          <PickRow
            key={item.itemId}
            taken
            changed={!!change || justTaken}
            name={name}
            sub={justTaken ? `${names[names.length - 1] ?? 'Someone'} just took this` : change?.text}
            aside={<AvatarStack names={names} />}
            price={formatGBP(item.unitPricePence * item.quantity)}
          />
        ),
      };
    }

    if (item.quantity > 1) {
      const names = others > 0 && mine === 0 ? (counts.who.get(item.itemId) ?? []).map((p) => firstName(p.displayName)) : [];
      return {
        taken: false,
        el: (
          <PickRow
            key={item.itemId}
            on={mine > 0}
            changed={!!change}
            busy={busy}
            action={mine > 0 ? undefined : 'Take one'}
            onTap={mine > 0 ? undefined : () => claimOne(item)}
            name={`${item.name} × ${item.quantity}`}
            sub={change?.text ?? `${formatGBP(item.unitPricePence)} each`}
            price={formatGBP(item.unitPricePence * (mine || 1))}
            aside={mine > 0 ? <Stepper n={mine} max={mine + left} busy={busy} onDec={() => dropOne(item.itemId)} onInc={() => claimOne(item)} name={item.name} /> : names.length > 0 ? <AvatarStack names={names} /> : undefined}
          />
        ),
      };
    }

    return {
      taken: false,
      el: (
        <PickRow
          key={item.itemId}
          on={mine > 0}
          busy={busy}
          action={mine > 0 ? 'Untick' : 'Tick'}
          onTap={() => (mine > 0 ? dropOne(item.itemId) : claimOne(item))}
          name={item.name}
          price={formatGBP(item.unitPricePence)}
          aside={mine === 0 ? <Button tone="text" small onClick={() => setSplitting({ item, ways: 2 })} aria-label={`Split ${item.name}`}>Split</Button> : undefined}
        />
      ),
    };
  });
  const taken = rows.filter((r) => r.taken);
  const visible = hideTaken ? rows.filter((r) => !r.taken) : rows;

  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title="What did you have?" sub={`${b.venue?.name ? `${b.venue.name} · ` : ''}${hostFirst}’s bill`} />
        <BillTools sessionId={s.sessionId} billId={s.billId} showQr={!!s.joinCode && s.status === 'claiming'} />
        <div className="vh" aria-live="polite">{liveText}</div>
        {b.items.length > 0 ? (
          <p className="small muted title-row">
            <span>{open.length > 0 ? `${formatGBP(leftPence)} left · ${open.length} ${open.length === 1 ? 'item' : 'items'}` : 'Everything’s claimed'}</span>
            {!hideTaken && taken.length > 0 ? <button type="button" className="link-btn" onClick={() => setHideTaken(true)}>Hide taken</button> : null}
          </p>
        ) : null}
        <Box>
          {visible.map((r) => r.el)}
          {hideTaken && taken.length > 0 ? (
            <button type="button" className="pick pick--fold" onClick={() => setHideTaken(false)}>Show taken ({taken.length})</button>
          ) : null}
        </Box>
        {err ? <Notice tone="error">{err}</Notice> : null}
      </Page>
      <ActionBar stack>
        {owed > 0 ? (
          <div className="actionbar__total">
            <span className="muted">Your share{rate > 0 ? ' incl. service' : ''}</span>
            <b data-testid="your-share">{formatGBP(owed)}</b>
          </div>
        ) : null}
        <Button href={`/session/${s.sessionId}/pay`} disabled={owed <= 0 || busy}>
          {owed > 0 ? 'Continue to payment' : 'Tick what you had'}
        </Button>
      </ActionBar>

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
    </>
  );
}

/** "Shared 2 ways with Priya · 1 open" */
export function splitSub(s: Session, share: Share, meUserId: string): string {
  const others = share.userIds.filter((u) => u !== meUserId).map((u) => firstName(s.participants.find((p) => p.userId === u)?.displayName));
  const seats = Math.max(0, share.ways - share.userIds.length);
  return [`Shared ${share.ways} ways${others.length ? ` with ${others.join(', ')}` : ''}`, seats ? `${seats} open` : null].filter(Boolean).join(' · ');
}

/** A tick row: the whole row is the tap target; a control on the right (Split, a stepper) sits outside it. */
export function PickRow({ on, taken, changed, busy, action, onTap, name, sub, price, aside }: {
  on?: boolean; taken?: boolean; /** #123: this row just changed because of someone else — a brief highlight. */ changed?: boolean; busy?: boolean; /** What a tap does ("Tick"), read out before the visible text. */ action?: string; onTap?: () => void; name: string; sub?: React.ReactNode; price: React.ReactNode; aside?: React.ReactNode;
}) {
  const tick = <span className={`tick${on ? ' tick--on' : taken ? ' tick--done' : ''}`} aria-hidden>{on || taken ? <TickIcon size={16} /> : null}</span>;
  const body = (
    <>
      {action ? <span className="vh">{action} </span> : null}
      {tick}
      <span className="row__main">
        <span className="row__title">{name}</span>
        {sub ? <span className="row__sub">{sub}</span> : null}
      </span>
    </>
  );
  return (
    <div className={`pick${taken ? ' pick--taken' : ''}${changed ? ' pick--changed' : ''}`}>
      {onTap ? (
        <button type="button" className="pick__tap" onClick={onTap} disabled={busy} aria-pressed={!!on}>{body}</button>
      ) : (
        <div className="pick__tap" style={{ cursor: 'default' }}>{body}</div>
      )}
      {aside}
      <span className="row__end">{price}</span>
    </div>
  );
}

export function Stepper({ n, max, busy, onDec, onInc, name }: { n: number; max: number; busy: boolean; onDec: () => void; onInc: () => void; name: string }) {
  return (
    <span className="stepper">
      <button type="button" aria-label={`One fewer ${name}`} disabled={busy} onClick={onDec}>−</button>
      <span aria-live="polite">{n}</span>
      <button type="button" aria-label={`One more ${name}`} disabled={busy || n >= max} onClick={onInc}>+</button>
    </span>
  );
}

export function SplitSheet({ item, ways, min, busy, error, onChange, onCancel, onOk }: {
  item: BillItem; ways: number; min: number; busy: boolean; error?: string; onChange: (n: number) => void; onCancel: () => void; onOk: () => void;
}) {
  return (
    <Dialog
      title={`Split ${item.name}`}
      onClose={onCancel}
      actions={
        <>
          <Button busy={busy} onClick={onOk}>{formatGBP(Math.ceil(item.unitPricePence / ways))} each</Button>
          <Button tone="secondary" onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <p className="muted">{formatGBP(item.unitPricePence)} between how many people, including you?</p>
      <div className="ways">
        <span className="stepper">
          <button type="button" aria-label="Fewer people" disabled={ways <= min} onClick={() => onChange(ways - 1)}>−</button>
        </span>
        <b aria-live="polite">{ways}</b>
        <span className="stepper">
          <button type="button" aria-label="More people" disabled={ways >= 20} onClick={() => onChange(ways + 1)}>+</button>
        </span>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Dialog>
  );
}

/* ============================ after paying (guest) ============================ */

export function GuestTable({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const [more, setMore] = useState(false);
  const me = s.participants.find((p) => p.userId === meUserId);
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const hostFirst = firstName(host?.displayName);
  const closed = s.status === 'settled';
  const statuses = useMemo(() => itemStatuses(s, b, meUserId), [s, b, meUserId]);
  const open = statuses.filter((x) => x.left > 0);

  const myOwed = me ? owedFor(s, b, me) : 0;
  const status = me?.payment.status;
  const sent = me?.payment.status === 'pending' && !!me.payment.payerClaimedPaidAt;
  const mustPay = closed && status !== 'succeeded' && status !== 'self_paid' && !sent && myOwed > 0;

  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title={b.venue?.name ?? `${hostFirst}’s bill`} sub={closed ? 'Bill closed' : `${hostFirst}’s bill`} />
        <BillTools sessionId={s.sessionId} billId={s.billId} showQr={!closed && !!s.joinCode} />
        {status === 'succeeded' ? (
          <Notice tone="ok" title={`${hostFirst} has your ${formatGBP(myOwed)}`}>You’re all settled.</Notice>
        ) : sent ? (
          <Notice tone="ok" title={`You’ve marked ${formatGBP(myOwed)} as paid`}>{hostFirst} will confirm when it arrives.</Notice>
        ) : mustPay ? (
          <Notice title={`You owe ${hostFirst} ${formatGBP(myOwed)}`} />
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
                return <Row key={id} title={item.name} sub={splitSub(s, share, meUserId)} end={formatGBP(sharePence(item.unitPricePence, share.userIds, share.ways, meUserId))} />;
              })}
            </Box>
            <Totals><TotalLine tone="total" k={b.serviceChargePence > 0 || b.taxPence > 0 ? 'Your total incl. service' : 'Your total'} v={formatGBP(myOwed)} /></Totals>
          </Section>
        ) : null}

        {!closed && open.length > 0 ? (
          <Section title="Still to claim">
            <Box>{open.map((st) => <ItemLine key={st.item.itemId} st={st} />)}</Box>
            {more ? <Notice>Let {hostFirst} know. They can take it on their bill and you can settle up between you.</Notice> : null}
          </Section>
        ) : null}

        {!closed ? <p className="small muted">{hostFirst} closes the bill once everyone’s paid.</p> : null}
      </Page>
      <ActionBar stack>
        {mustPay ? (
          <Button href={`/session/${s.sessionId}/pay`}>Pay {hostFirst} {formatGBP(myOwed)}</Button>
        ) : !closed && open.length > 0 && !more ? (
          <Button tone="secondary" onClick={() => setMore(true)}>I had something else</Button>
        ) : (
          <Button tone={closed ? 'primary' : 'secondary'} href="/" replace>{closed ? 'Done' : 'Back to bills'}</Button>
        )}
      </ActionBar>
    </>
  );
}
