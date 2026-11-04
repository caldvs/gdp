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
  item: BillItem;
  group: ClaimGroup;
  /** `multi`: several of one thing, claimed one portion at a time. */
  kind: 'multi' | 'single' | 'share';
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

/** Every bill line, in bill order, with its group and who has it. */
export function claimRows(s: Session, b: Bill, meUserId: string): ClaimRow[] {
  return b.items.map((item) => {
    const share = s.shares?.find((x) => x.itemId === item.itemId && x.userIds.length > 0);
    if (share) {
      const others = share.userIds
        .filter((u) => u !== meUserId)
        .map((u) => s.participants.find((p) => p.userId === u))
        .filter((p): p is Participant => !!p);
      const inShare = share.userIds.includes(meUserId);
      const left = Math.max(0, share.ways - share.userIds.length);
      return {
        item,
        kind: 'share',
        group: inShare ? 'yours' : left > 0 ? 'open' : 'others',
        mine: inShare ? 1 : 0,
        left,
        others,
        share,
        canSplit: !inShare && left === 0 && !others.some(hasPaid),
      };
    }
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
    const left = Math.max(0, item.quantity - taken);
    const kind = item.quantity > 1 ? 'multi' : 'single';
    return {
      item,
      kind,
      group: mine > 0 ? 'yours' : left > 0 ? 'open' : 'others',
      mine,
      left,
      others,
      canSplit: kind === 'single' && mine === 0 && left === 0 && !others.some(hasPaid),
    };
  });
}
