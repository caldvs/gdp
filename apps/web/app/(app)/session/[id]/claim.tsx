'use client';

/**
 * Claiming (#215, board G2 and G2.1): the bill as a receipt, one list in bill
 * order whose lines never move. Several of one thing show as a row per
 * portion ("Negroni 2 of 2"), each with Claim; claimed turns to ✓ Claimed
 * (tap to undo); someone else's says "Sam has it", with ⋯ (split) on a dish one
 * person has. Split opens the row in place: how many ways and your share.
 * They're told, not asked (decisions: *Claiming is one list in bill order*).
 * Guests pick here, and the lead uses the same list for their own lines.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ApiError, type components } from '@gdp/core/api';
import { useAddShare, useRemoveShare, useSetClaims, useSetShareWays } from '@gdp/core/api/hooks/useSession';
import { claimPortions, type ClaimPortion } from '@gdp/core/lib/claimRows';
import { itemStatuses as coreItemStatuses, type ItemStatus } from '@gdp/core/lib/leftovers';
import { formatGBP } from '@gdp/core/lib/money';
import { sharePence, splitPricePence } from '@gdp/core/lib/owed';
import { Button, MoreIcon, Notice, Receipt, ReceiptLine, firstName } from '@/components/ui';

const itemStatuses = (s: Session, b: Bill, meUserId: string) => coreItemStatuses(s, b, meUserId, (p) => firstName(p?.displayName));

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];

const nameOf = (p: Participant | undefined) => firstName(p?.displayName, 'Guest');
/** "Priya", "Priya and Tom", "Priya, Sam and Tom" */
export const listNames = (ns: string[]) => (ns.length < 2 ? ns.join('') : `${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`);
const plain = (pence: number) => (pence / 100).toFixed(2);

function shareError(err: ApiError): string {
  if (err.code === 'SHARE_PAID') return 'They’ve paid for it, so it can’t be split now.';
  if (err.code === 'SHARE_WAYS_TOO_LOW') return 'More people are in it already.';
  return err.message;
}

/** The row whose split is open, how many ways, and whether it's mine to change (fixed when it opens). */
type Splitting = { key: string; ways: number; mine: boolean };

export function ClaimList({ s, b, meUserId }: { s: Session; b: Bill; meUserId: string }) {
  const setClaims = useSetClaims(s.sessionId);
  const addShare = useAddShare(s.sessionId);
  const removeShare = useRemoveShare(s.sessionId);
  const setWays = useSetShareWays(s.sessionId);
  const [splitting, setSplitting] = useState<Splitting | null>(null);
  // #123: the row a tap just lost the race for.
  const [raceLost, setRaceLost] = useState<string | null>(null);
  // Which portion rows I tapped, so mine stay where I put them.
  const [prefer, setPrefer] = useState<Record<string, number[]>>({});

  const me = s.participants.find((p) => p.userId === meUserId);
  const host = s.participants.find((p) => p.userId === s.creatorUserId);
  const rows = useMemo(() => claimPortions(s, b, meUserId, prefer), [s, b, meUserId, prefer]);
  const statuses = useMemo(() => itemStatuses(s, b, meUserId), [s, b, meUserId]);
  const { changes, liveText } = useChangeFeed(statuses);
  const busy = setClaims.isPending || addShare.isPending || removeShare.isPending || setWays.isPending;
  // #195: while a claim saves, its controls say they're unavailable rather
  // than going `disabled`, which would drop keyboard focus to the page. And
  // when a row's controls swap (Claim → Claimed), focus follows to the new one.
  const boxRef = useRef<HTMLDivElement>(null);
  const refocus = useRefocus(boxRef);
  const act = (key: string, fn: () => void) => () => {
    if (busy) return;
    refocus.mark(key);
    fn();
  };
  const off = busy || undefined;

  const claim = (r: ClaimPortion) => {
    if (!me) return;
    setRaceLost(null);
    if (r.n) setPrefer((p) => ({ ...p, [r.item.itemId]: [...(p[r.item.itemId] ?? []).filter((n) => n !== r.n), r.n!] }));
    setClaims.mutate(
      { claimedItemIds: [...me.claimedItemIds, r.item.itemId] },
      {
        onError: (e) => {
          const itemId = e instanceof ApiError ? (e.details as { itemId?: string } | undefined)?.itemId : undefined;
          if (e instanceof ApiError && e.code === 'SESSION_INVALID_STATE' && itemId === r.item.itemId) setRaceLost(r.key);
        },
      },
    );
  };
  const unclaim = (r: ClaimPortion) => {
    if (!me) return;
    const next = [...me.claimedItemIds];
    const i = next.lastIndexOf(r.item.itemId);
    if (i < 0) return;
    next.splice(i, 1);
    setRaceLost(null);
    if (r.n) setPrefer((p) => ({ ...p, [r.item.itemId]: (p[r.item.itemId] ?? []).filter((n) => n !== r.n) }));
    setClaims.mutate({ claimedItemIds: next });
  };

  const claimErr = setClaims.error && !(raceLost && setClaims.error.code === 'SESSION_INVALID_STATE') ? setClaims.error.message : undefined;
  const err = claimErr ?? (addShare.error && !splitting ? shareError(addShare.error) : undefined) ?? removeShare.error?.message;

  // #123: a change someone else made shows on the line's first row that isn't mine.
  const flashAt = new Map<string, string>();
  for (const [itemId, c] of changes) {
    const r = rows.find((x) => x.item.itemId === itemId && x.state !== 'mine');
    const mineFlash = c.text.startsWith('Split with');
    const target = r ?? (mineFlash ? rows.find((x) => x.item.itemId === itemId) : undefined);
    if (target) flashAt.set(target.key, c.text);
  }

  const render = (r: ClaimPortion) => {
    const { item, key } = r;
    const portion = r.n ? ` ${r.n} of ${r.of}` : '';
    const label = `${item.name}${portion}`;
    const holder = listNames(r.holders.map(nameOf));
    if (splitting?.key === key) {
      return (
        <SplitPanel
          key={key}
          r={r}
          ways={splitting.ways}
          mine={splitting.mine}
          meUserId={meUserId}
          busy={addShare.isPending || setWays.isPending}
          error={setWays.error ? shareError(setWays.error) : addShare.error ? shareError(addShare.error) : undefined}
          onWays={(ways) => setSplitting({ ...splitting, ways })}
          onCancel={() => { refocus.mark(key); setSplitting(null); addShare.reset(); setWays.reset(); }}
          onOk={() => {
            const done = { onSuccess: () => { refocus.mark(key); setRaceLost(null); setSplitting(null); } };
            if (splitting.mine) setWays.mutate({ itemId: item.itemId, ways: splitting.ways }, done);
            else addShare.mutate({ itemId: item.itemId, ways: splitting.ways }, done);
          }}
        />
      );
    }

    let price = plain(r.kind === 'share' ? splitPricePence(item, r.share!) : item.unitPricePence);
    let note: string | undefined;
    let tools: ReactNode = null;

    if (r.kind === 'share') {
      const share = r.share!;
      const units = r.units && r.units > 1 ? `${r.units} of ${item.quantity} · ` : '';
      const each = formatGBP(sharePence(splitPricePence(item, share), share.userIds, share.ways, meUserId));
      if (r.state === 'mine') {
        note = `${units}Your share ${each} · ${holder ? `with ${holder}` : `split ${share.ways} ways`}${r.left ? ` · ${r.left} open` : ''}`;
        tools = (
          <span className="claim-line__tools">
            <button type="button" className="link-btn" onClick={() => { setWays.reset(); setSplitting({ key, ways: share.ways, mine: true }); }} aria-label={`Change how many ways ${item.name} is split`}>{share.ways} ways</button>
            <button type="button" className="claim-btn" data-main aria-pressed="true" aria-disabled={off} onClick={act(key, () => removeShare.mutate({ itemId: item.itemId }))} aria-label={`Stop splitting ${item.name}`}>✓ Sharing</button>
          </span>
        );
      } else if (r.state === 'open') {
        note = `${units}Split ${share.ways} ways · ${each} each · ${r.left} open`;
        tools = <button type="button" className="claim-btn" data-main aria-disabled={off} onClick={act(key, () => addShare.mutate({ itemId: item.itemId }))} aria-label={`Join the split for ${item.name}, ${each} each`}>Join</button>;
      } else {
        note = `${units}Split ${share.ways} ways · ${holder}`;
      }
    } else if (r.state === 'mine') {
      note = r.n ? `${r.n} of ${r.of}` : undefined;
      tools = (
        <button type="button" className="claim-btn" data-main aria-pressed="true" aria-disabled={off} onClick={act(key, () => unclaim(r))} aria-label={`Claimed. Remove ${label}, ${formatGBP(item.unitPricePence)}`}>✓ Claimed</button>
      );
    } else if (r.state === 'open') {
      note = r.n ? `${r.n} of ${r.of} · ${r.left} left` : undefined;
      tools = (
        <button type="button" className="claim-btn" data-main aria-disabled={off} onClick={act(key, () => claim(r))} aria-label={`Claim ${label}, ${formatGBP(item.unitPricePence)}`}>Claim</button>
      );
    } else {
      const lost = raceLost === key;
      note = `${r.n ? `${r.n} of ${r.of} · ` : ''}${lost ? `${holder || 'Someone'} just took this` : `${holder} has it`}`;
    }

    if (r.state === 'theirs' && r.canSplit) {
      const ways = r.share ? r.share.userIds.length + 1 : 2;
      tools = (
        // #225: ⋯ opens the split row in place; no word Split on the list.
        <button type="button" className="claim-more" data-main aria-disabled={off} onClick={act(key, () => { addShare.reset(); setSplitting({ key, ways, mine: false }); })} aria-label={`More for ${item.name}`}>
          <MoreIcon />
        </button>
      );
    }

    const flash = flashAt.get(key);
    if (r.kind === 'share' && r.units && r.units > 1) price = plain(splitPricePence(item, r.share!));
    return (
      <div key={key} className={['claim-line', r.state === 'mine' && 'claim-line--mine', flash && 'pick--changed'].filter(Boolean).join(' ')} data-group={r.state === 'mine' ? 'yours' : r.state === 'open' ? 'open' : 'others'} data-row={key}>
        <ReceiptLine name={item.name} note={flash ?? note} price={price} tools={tools} quiet={r.state === 'theirs'} />
      </div>
    );
  };

  return (
    <>
      <div className="vh" aria-live="polite">{liveText}</div>
      <div ref={boxRef} style={{ display: 'contents' }}>
        <h2 className="vh">Items</h2>
        <Receipt head={b.venue?.name ?? 'The bill'} end={host ? `${host.userId === meUserId ? 'You' : nameOf(host)} paid` : undefined}>
          {rows.map(render)}
        </Receipt>
      </div>
      {err ? <Notice tone="error">{err}</Notice> : null}
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

/**
 * #195: remember which row a tap was on, and if that row's controls are
 * swapped out from under the keyboard (focus falls to the page), focus the
 * row's main control again. Any tap or focus elsewhere forgets it.
 */
function useRefocus(boxRef: RefObject<HTMLDivElement | null>) {
  const pending = useRef<string | null>(null);
  useEffect(() => {
    const forget = (e: Event) => {
      const row = (e.target as Element | null)?.closest?.('[data-row]');
      if (row?.getAttribute('data-row') !== pending.current) pending.current = null;
    };
    document.addEventListener('pointerdown', forget, true);
    document.addEventListener('focusin', forget, true);
    return () => {
      document.removeEventListener('pointerdown', forget, true);
      document.removeEventListener('focusin', forget, true);
    };
  }, []);
  useEffect(() => {
    const key = pending.current;
    const box = boxRef.current;
    if (!key || !box) return;
    // Lost: fallen to the page, removed, or just disabled (the browser
    // moves focus off a disabled button later, without another render).
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !active.matches(':disabled')) return;
    const row = [...box.querySelectorAll<HTMLElement>('[data-row]')].find((el) => el.dataset.row === key);
    if (!row) return;
    // The row's main control; on a stepper, + unless it's run out, then −.
    const mains = row.querySelectorAll<HTMLElement>('[data-main]:not([disabled])');
    (mains[mains.length - 1] ?? row.querySelector<HTMLElement>('button:not([disabled])'))?.focus();
  });
  return { mark: (key: string) => { pending.current = key; } };
}


/**
 * G2.1: Split, opened in place of the row by ⋯. On someone else's dish: how
 * many ways (2 to start) and your share; they're told, not asked (#225 drops
 * the line saying so). Joining a full split adds one way. On your own split:
 * change how many ways.
 */
function SplitPanel({ r: opened, ways, mine, meUserId, busy, error, onWays, onCancel, onOk }: {
  r: ClaimPortion; ways: number; mine: boolean; meUserId: string; busy: boolean; error?: string;
  onWays: (n: number) => void; onCancel: () => void; onOk: () => void;
}) {
  // The row as it was when ⋯ was tapped: saving updates the list at once,
  // and the panel shouldn't change under the button while it does.
  const [r] = useState(opened);
  const { item, share } = r;
  const holder = listNames(r.holders.map(nameOf)) || 'them';
  const price = share ? splitPricePence(item, share) : item.unitPricePence;
  // Joining a full split takes the next way; only a fresh split or your own sets them.
  const fixed = !mine && !!share;
  const min = mine && share ? Math.max(2, share.userIds.length) : 2;
  const userIds = share ? share.userIds : r.holders.map((p) => p.userId);
  const each = sharePence(price, userIds, ways, meUserId);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); }, []);
  const title = `${item.name}${mine ? '' : ` · ${holder} ${share ? 'are sharing it' : 'has it'}`}`;
  return (
    <div ref={ref} className="split-panel" role="group" aria-label={`Split ${item.name}`} tabIndex={-1} data-row={r.key} data-group={mine ? 'yours' : 'others'}>
      <div className="split-panel__head"><b>{title}</b><span className="receipt__price">{plain(price)}</span></div>
      <p className="split-panel__ask">{mine ? 'How many ways?' : `Split it with ${holder}?`}</p>
      {fixed ? null : (
        <div className="split-panel__row">
          <span>Ways</span>
          <span className="stepper">
            <button type="button" aria-label="Fewer ways" disabled={ways <= min} onClick={() => onWays(ways - 1)}>−</button>
            <span aria-live="polite">{ways}</span>
            <button type="button" aria-label="More ways" disabled={ways >= 20} onClick={() => onWays(ways + 1)}>+</button>
          </span>
        </div>
      )}
      <div className="split-panel__row"><span>Your share</span><b>{formatGBP(each)}</b></div>
      <div className="split-panel__acts">
        <Button tone="secondary" small onClick={onCancel}>Cancel</Button>
        <Button small busy={busy} onClick={onOk}>{mine ? 'Save' : 'Split it'}</Button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}
