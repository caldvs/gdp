'use client';

/**
 * Claiming by portion (#130, board G2.1–G2.4). One list in bill order that
 * stays put (#177): claiming a row changes it in place (tinted, ticked)
 * rather than moving it to a Yours list above, so claiming several things
 * needs no scrolling back and forth. Guests pick here, and the lead uses the same list on
 * their Your items tab (#131). Several of one thing are claimed a portion
 * at a time, never more than were ordered; someone else's dish can be
 * split with them at once (they're told, not asked: docs/decisions.md).
 * Some of several (2 of 4 bottles) can be split too: the split gets its
 * own row above the rest of the line.
 */
import { startTransition, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, type components } from '@gdp/core/api';
import { useAddShare, useRemoveShare, useSetClaims, useSetShareWays } from '@gdp/core/api/hooks/useSession';
import { claimRows, type ClaimRow } from '@gdp/core/lib/claimRows';
import { itemStatuses as coreItemStatuses, type ItemStatus } from '@gdp/core/lib/leftovers';
import { formatGBP } from '@gdp/core/lib/money';
import { sharePence, splitPricePence } from '@gdp/core/lib/owed';
import { AvatarStack, Box, Button, Dialog, Notice, TickIcon, TotalLine, Totals, firstName } from '@/components/ui';

const itemStatuses = (s: Session, b: Bill, meUserId: string) => coreItemStatuses(s, b, meUserId, (p) => firstName(p?.displayName));

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];
type BillItem = components['schemas']['BillItem'];
type Share = NonNullable<Session['shares']>[number];

const nameOf = (p: Participant | undefined) => firstName(p?.displayName, 'Guest');
/** "Priya", "Priya and Tom", "Priya, Sam and Tom" */
export const listNames = (ns: string[]) => (ns.length < 2 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);

function shareError(err: ApiError): string {
  if (err.code === 'SHARE_PAID') return 'They’ve paid for it, so it can’t be split now.';
  if (err.code === 'SHARE_WAYS_TOO_LOW') return 'More people are in it already.';
  return err.message;
}

export function ClaimList({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const setClaims = useSetClaims(s.sessionId);
  const addShare = useAddShare(s.sessionId);
  const removeShare = useRemoveShare(s.sessionId);
  const setWays = useSetShareWays(s.sessionId);
  // Splitting someone else's dish: confirm first (G2.3).
  const [confirming, setConfirming] = useState<ClaimRow | null>(null);
  // Starting a split of something nobody has, or changing how many ways.
  // `units`/`maxUnits`: how many of a longer line it covers, and how many
  // are free to split.
  const [waysSheet, setWaysSheet] = useState<{ item: BillItem; ways: number; units: number; maxUnits: number; share?: Share } | null>(null);
  // #123: an item a tap just lost the race for.
  const [raceLost, setRaceLost] = useState<string | null>(null);

  const me = s.participants.find((p) => p.userId === meUserId);
  const rows = useMemo(() => claimRows(s, b, meUserId), [s, b, meUserId]);
  const statuses = useMemo(() => itemStatuses(s, b, meUserId), [s, b, meUserId]);
  const { changes, liveText } = useChangeFeed(statuses);
  const busy = setClaims.isPending || addShare.isPending || removeShare.isPending;

  const claimOne = (item: BillItem) => {
    if (!me) return;
    setRaceLost(null);
    setClaims.mutate(
      { claimedItemIds: [...me.claimedItemIds, item.itemId] },
      {
        onError: (e) => {
          const itemId = e instanceof ApiError ? (e.details as { itemId?: string } | undefined)?.itemId : undefined;
          if (e instanceof ApiError && e.code === 'SESSION_INVALID_STATE' && itemId === item.itemId) setRaceLost(item.itemId);
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
    setRaceLost(null);
    setClaims.mutate({ claimedItemIds: next });
  };

  const claimErr = setClaims.error && !(raceLost && setClaims.error.code === 'SESSION_INVALID_STATE') ? setClaims.error.message : undefined;
  const err = claimErr ?? (addShare.error && !confirming ? shareError(addShare.error) : undefined) ?? removeShare.error?.message;

  const render = (r: ClaimRow) => {
    const { item, kind, mine, left, others, share, count } = r;
    const names = others.map(nameOf);
    const unit = formatGBP(item.unitPricePence);
    const title = (kind === 'multi' || count > 1) ? `${count} × ${item.name}` : item.name;
    // A longer line with no split yet can have some of it split.
    const splitLink = kind === 'multi' && left > 0 && !s.shares?.some((x) => x.itemId === item.itemId && x.userIds.length > 0) ? (
      <button type="button" className="link-btn" onClick={() => setWaysSheet({ item, ways: 2, units: left, maxUnits: left })} aria-label={`Split some ${item.name}`}>Split</button>
    ) : null;
    // In Yours, only someone splitting my dish is news; the rest was my doing.
    const flash = changes.get(item.itemId)?.text;
    const change = r.group === 'yours' && !flash?.startsWith('Split with') ? undefined : flash;
    const key = r.key;
    const row = (note: string, action?: ReactNode) => (
      <ClaimItem key={key} group={r.group} title={title} names={names} note={change ?? note} action={action} changed={!!change} />
    );

    if (r.group === 'yours') {
      if (kind === 'multi') {
        return row(`${unit} each · ${left > 0 ? `${left} left` : 'all claimed'}`, (
          <>
            {splitLink}
            <Stepper n={mine} max={mine + left} busy={busy} onDec={() => dropOne(item.itemId)} onInc={() => claimOne(item)} name={item.name} />
          </>
        ));
      }
      if (kind === 'single') {
        // Where Claim was, so the row doesn't shift: tap again to put it back.
        return row(unit, (
          <Button tone="secondary" small className="claim__btn claim__btn--on" disabled={busy} onClick={() => dropOne(item.itemId)} aria-label={`Claimed. Remove ${item.name}`}>
            <TickIcon size={16} />Claimed
          </Button>
        ));
      }
      const each = sharePence(splitPricePence(item, share!), share!.userIds, share!.ways, meUserId);
      const note = [formatGBP(each), names.length ? `split with ${listNames(names)}` : `split ${share!.ways} ways`, left ? `${left} open` : null].filter(Boolean).join(' · ');
      return row(note, (
        <>
          <button type="button" className="link-btn" onClick={() => setWaysSheet({ item, ways: share!.ways, units: count, maxUnits: count, share })} aria-label={`Change how many ways ${item.name} is split`}>{share!.ways} ways</button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => removeShare.mutate({ itemId: item.itemId })} aria-label={`Stop splitting ${item.name}`}>Remove</button>
        </>
      ));
    }

    if (r.group === 'open') {
      if (kind === 'share') {
        const each = sharePence(splitPricePence(item, share!), share!.userIds, share!.ways, meUserId);
        return row(`${formatGBP(each)} each · ${left} open`,
          <Button tone="secondary" small className="claim__btn" disabled={busy} onClick={() => addShare.mutate({ itemId: item.itemId })} aria-label={`Join the split for ${item.name}`}>Join</Button>);
      }
      if (kind === 'multi') {
        return row(`${unit} each · ${left} left`, (
          <>
            {splitLink}
            <Button tone="secondary" small className="claim__btn" disabled={busy} onClick={() => claimOne(item)} aria-label={`Claim one ${item.name}`}>Claim</Button>
          </>
        ));
      }
      return row(unit, (
        <>
          <button type="button" className="link-btn" onClick={() => setWaysSheet({ item, ways: 2, units: 1, maxUnits: 1 })} aria-label={`Split ${item.name}`}>Split</button>
          <Button tone="secondary" small className="claim__btn" disabled={busy} onClick={() => claimOne(item)} aria-label={`Claim ${item.name}`}>Claim</Button>
        </>
      ));
    }

    // Claimed by others.
    const lost = raceLost === item.itemId;
    const holder = listNames(names);
    const splitBtn = r.canSplit ? (
      <Button tone="text" small className="claim__btn" disabled={busy} onClick={() => { addShare.reset(); setConfirming(r); }} aria-label={`Split ${item.name} with ${holder || 'them'}`}>
        {lost ? `Split with ${holder}` : 'Split'}
      </Button>
    ) : undefined;
    if (lost) return row(`${names[names.length - 1] ?? 'Someone'} just took this`, splitBtn);
    if (kind === 'multi') return row('All claimed');
    if (kind === 'share') return row(`Split ${share!.ways} ways`, splitBtn);
    return row(unit, splitBtn);
  };

  return (
    <>
      <div className="vh" aria-live="polite">{liveText}</div>
      <h2 className="vh">Items</h2>
      <Box list>{rows.map(render)}</Box>
      {err ? <Notice tone="error">{err}</Notice> : null}

      {confirming ? (
        <SplitConfirm
          row={confirming}
          meUserId={meUserId}
          busy={addShare.isPending}
          error={addShare.error ? shareError(addShare.error) : undefined}
          onCancel={() => { startTransition(() => setConfirming(null)); addShare.reset(); }}
          onOk={() => addShare.mutate({ itemId: confirming.item.itemId }, { onSuccess: () => { setRaceLost(null); startTransition(() => setConfirming(null)); } })}
        />
      ) : null}
      {waysSheet ? (
        <SplitSheet
          item={waysSheet.item}
          ways={waysSheet.ways}
          units={waysSheet.units}
          maxUnits={waysSheet.share ? undefined : waysSheet.maxUnits}
          min={Math.max(2, waysSheet.share?.userIds.length ?? 1)}
          busy={addShare.isPending || setWays.isPending}
          error={setWays.error ? shareError(setWays.error) : addShare.error && !confirming ? shareError(addShare.error) : undefined}
          onChange={(ways) => setWaysSheet({ ...waysSheet, ways })}
          onUnits={(units) => setWaysSheet({ ...waysSheet, units })}
          onCancel={() => { startTransition(() => setWaysSheet(null)); setWays.reset(); }}
          onOk={() => {
            const done = () => startTransition(() => setWaysSheet(null));
            if (waysSheet.share) setWays.mutate({ itemId: waysSheet.item.itemId, ways: waysSheet.ways }, { onSuccess: done });
            else addShare.mutate({ itemId: waysSheet.item.itemId, ways: waysSheet.ways, ...(waysSheet.item.quantity > 1 && { units: waysSheet.units }) }, { onSuccess: done });
          }}
        />
      ) : null}
    </>
  );
}

type Change = { text: string };

/**
 * #123: when a row changes because of someone ELSE — claimed, partly
 * claimed, or joined a split — say what happened for a moment. Diffs this
 * poll's statuses against the last one; a row where *my* count didn't move
 * but who has it did is someone else's doing. The batch clears after ~2s.
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
      else if (st.left < was.left) batch.set(id, { text: st.left === 0 ? `${newcomer} took it` : `${st.left} of ${st.item.quantity} left` });
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

export function Stepper({ n, max, busy, onDec, onInc, name }: { n: number; max: number; busy: boolean; onDec: () => void; onInc: () => void; name: string }) {
  return (
    <span className="stepper stepper--sm">
      <button type="button" aria-label={`One fewer ${name}`} disabled={busy} onClick={onDec}>−</button>
      <span aria-live="polite">{n}</span>
      <button type="button" aria-label={`One more ${name}`} disabled={busy || n >= max} onClick={onInc}>+</button>
    </span>
  );
}

export function SplitSheet({ item, ways, min, units = 1, maxUnits, busy, error, onChange, onUnits, onCancel, onOk }: {
  item: BillItem; ways: number; min: number;
  /** How many of the line (several of one thing), and how many can be split; no maxUnits → fixed. */
  units?: number; maxUnits?: number;
  busy: boolean; error?: string; onChange: (n: number) => void; onUnits?: (n: number) => void; onCancel: () => void; onOk: () => void;
}) {
  const price = item.unitPricePence * units;
  return (
    <Dialog
      title={`Split ${item.name}`}
      onClose={onCancel}
      actions={
        <>
          <Button busy={busy} onClick={onOk}>{formatGBP(Math.ceil(price / ways))} each</Button>
          <Button tone="secondary" onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      {maxUnits !== undefined && maxUnits > 1 && onUnits ? (
        <>
          <p className="muted">How many?</p>
          <div className="ways">
            <span className="stepper">
              <button type="button" aria-label={`Fewer ${item.name}`} disabled={units <= 1} onClick={() => onUnits(units - 1)}>−</button>
            </span>
            <b aria-live="polite">{units}</b>
            <span className="stepper">
              <button type="button" aria-label={`More ${item.name}`} disabled={units >= maxUnits} onClick={() => onUnits(units + 1)}>+</button>
            </span>
          </div>
        </>
      ) : null}
      <p className="muted">{units > 1 ? `${units} × ${item.name}, ${formatGBP(price)}` : formatGBP(price)} between how many people, including you?</p>
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

/** One line on the claiming list: name, who has it and a note, then what you can do. */
function ClaimItem({ group, title, names, note, action, changed }: {
  group: ClaimRow['group']; title: string; names: string[]; note: string; action?: ReactNode; /** #123: someone else just changed it. */ changed: boolean;
}) {
  const cls = ['claim', group === 'yours' && 'claim--mine', group === 'others' && 'claim--muted', changed && 'pick--changed'].filter(Boolean).join(' ');
  return (
    <div className={cls} data-group={group}>
      <span className="row__main">
        <span className="row__title">{title}</span>
        <span className="row__sub claim__sub">{names.length > 0 ? <AvatarStack names={names} /> : null}<span>{note}</span></span>
      </span>
      {action ? <span className="claim__act">{action}</span> : null}
    </div>
  );
}

/** G2.3: "Split the calamari with Priya?" Priya is told, not asked. */
function SplitConfirm({ row, meUserId, busy, error, onOk, onCancel }: {
  row: ClaimRow; meUserId: string; busy: boolean; error?: string; onOk: () => void; onCancel: () => void;
}) {
  const { item, share, others } = row;
  const who = listNames(others.map(nameOf)) || 'them';
  const price = share ? splitPricePence(item, share) : item.unitPricePence;
  const mine = share
    ? sharePence(price, share.userIds, share.ways + 1, meUserId)
    : sharePence(price, others.map((p) => p.userId), 2, meUserId);
  return (
    <Dialog
      id="split-confirm-t"
      title={`Split the ${item.name.toLowerCase()} with ${who}?`}
      onClose={onCancel}
      actions={
        <>
          <Button busy={busy} onClick={onOk}>Split it</Button>
          <Button tone="secondary" onClick={onCancel}>Cancel</Button>
        </>
      }
    >
      <Totals>
        <TotalLine tone="mute" k={row.count > 1 ? `${row.count} × ${item.name}` : item.name} v={formatGBP(price)} />
        <TotalLine tone="total" k="Your share" v={formatGBP(mine)} />
      </Totals>
      <p className="muted">{who} will see you’re sharing it.</p>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </Dialog>
  );
}
