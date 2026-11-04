import type { components } from '../api';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];
type BillItem = components['schemas']['BillItem'];
type Share = NonNullable<Session['shares']>[number];

/**
 * Where a bill line sits on the claiming screen (#130): Yours, Still to
 * claim, or Claimed by others.
 */
export type ClaimGroup = 'yours' | 'open' | 'others';

export type ClaimRow = {
  /** Unique per row: the itemId, or `<itemId>:split` for a longer line's split. */
  key: string;
  item: BillItem;
  group: ClaimGroup;
  /** `multi`: several of one thing, claimed one portion at a time. */
  kind: 'multi' | 'single' | 'share';
  /**
   * How many of the line this row is about: the split's units (share), the
   * units outside any split (multi), else 1.
   */
  count: number;
  /** Portions I've claimed (multi, single). */
  mine: number;
  /** Portions nobody has claimed (multi, single); open spots (share). */
  left: number;
  /** Everyone else who has some of it, in the order they took it. */
  others: Participant[];
  share?: Share;
  /**
   * Someone else's dish I can split: one thing one person claimed, or a
   * split with no spot left. Not once any of them has paid, since what
   * they've paid can't change (the API says SHARE_PAID).
   */
  canSplit: boolean;
};

/** Has this person paid, or started paying? Mirrors the API's anySharerPaid. */
export const hasPaid = (p: Participant): boolean =>
  p.payment.status === 'pending' || p.payment.status === 'succeeded';

/**
 * Every bill line, in bill order, with its group and who has it. A line
 * with more than one of something that has a split shows as two rows: the
 * split (its units), then the rest, claimed one at a time.
 */
export function claimRows(s: Session, b: Bill, meUserId: string): ClaimRow[] {
  return b.items.flatMap((item): ClaimRow[] => {
    const share = s.shares?.find((x) => x.itemId === item.itemId && x.userIds.length > 0);
    const multi = item.quantity > 1;
    const out: ClaimRow[] = [];
    if (share) {
      const others = share.userIds
        .filter((u) => u !== meUserId)
        .map((u) => s.participants.find((p) => p.userId === u))
        .filter((p): p is Participant => !!p);
      const inShare = share.userIds.includes(meUserId);
      const left = Math.max(0, share.ways - share.userIds.length);
      out.push({
        key: multi ? `${item.itemId}:split` : item.itemId,
        item,
        kind: 'share',
        count: share.units ?? 1,
        group: inShare ? 'yours' : left > 0 ? 'open' : 'others',
        mine: inShare ? 1 : 0,
        left,
        others,
        share,
        canSplit: !inShare && left === 0 && !others.some(hasPaid),
      });
      if (!multi) return out;
    }
    const count = item.quantity - (share ? (share.units ?? 1) : 0);
    if (count <= 0) return out;
    let mine = 0;
    let taken = 0;
    const others: Participant[] = [];
    for (const p of s.participants) {
      const n = p.claimedItemIds.filter((id) => id === item.itemId).length;
      if (n === 0) continue;
      taken += n;
      if (p.userId === meUserId) mine = n;
      else others.push(p);
    }
    const left = Math.max(0, count - taken);
    const kind = multi ? 'multi' : 'single';
    out.push({
      key: item.itemId,
      item,
      kind,
      count,
      group: mine > 0 ? 'yours' : left > 0 ? 'open' : 'others',
      mine,
      left,
      others,
      canSplit: kind === 'single' && mine === 0 && left === 0 && !others.some(hasPaid),
    });
    return out;
  });
}
