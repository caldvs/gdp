import type { components } from '../api';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];
type BillItem = components['schemas']['BillItem'];
type Share = NonNullable<Session['shares']>[number];

/**
 * One bill line and who has it. `left` is the units nobody has claimed; a
 * split counts as one unit taken (v1 splits are quantity-1 items only).
 */
export type ItemStatus = { item: BillItem; left: number; mine: number; who: string[]; share?: Share };

/**
 * Every bill line in bill order with who has it, so lists keep their shape
 * while people claim: a row changes state instead of vanishing. `nameOf`
 * turns a participant (undefined if a share names someone who has left)
 * into the label shown; the caller is always "you".
 */
export function itemStatuses(
  s: Session,
  b: Bill,
  meUserId: string,
  nameOf: (p: Participant | undefined) => string,
): ItemStatus[] {
  const taken = new Map<string, number>();
  const mine = new Map<string, number>();
  const who = new Map<string, string[]>();
  const add = (id: string, p: Participant) => {
    taken.set(id, (taken.get(id) ?? 0) + 1);
    if (p.userId === meUserId) mine.set(id, (mine.get(id) ?? 0) + 1);
    const l = who.get(id) ?? [];
    const n = p.userId === meUserId ? 'you' : nameOf(p);
    if (!l.includes(n)) l.push(n);
    who.set(id, l);
  };
  for (const p of s.participants) for (const id of p.claimedItemIds) add(id, p);
  for (const sh of s.shares ?? []) {
    if (sh.userIds.length === 0) continue;
    taken.set(sh.itemId, (taken.get(sh.itemId) ?? 0) + 1);
    const names = sh.userIds.map((uid) =>
      uid === meUserId ? 'you' : nameOf(s.participants.find((p) => p.userId === uid)),
    );
    who.set(sh.itemId, [...(who.get(sh.itemId) ?? []), ...names]);
    if (sh.userIds.includes(meUserId)) mine.set(sh.itemId, (mine.get(sh.itemId) ?? 0) + 1);
  }
  return b.items.map((item) => {
    const share = s.shares?.find((x) => x.itemId === item.itemId && x.userIds.length > 0);
    return {
      item,
      left: Math.max(0, item.quantity - (taken.get(item.itemId) ?? 0)),
      mine: mine.get(item.itemId) ?? 0,
      who: who.get(item.itemId) ?? [],
      ...(share ? { share } : {}),
    };
  });
}

/**
 * What the lead's "I'll cover these" takes: every unclaimed unit that isn't
 * in a split (an item is claimed or split, never both; the API refuses a
 * claim on a shared item). `claimedItemIds` is the lead's new full claim
 * list, one entry per unit, ready for a single setClaims call.
 */
export function coverLeftovers(
  s: Session,
  statuses: readonly ItemStatus[],
  myClaimedItemIds: readonly string[],
): { lines: ItemStatus[]; pence: number; claimedItemIds: string[] } {
  const sharedIds = new Set(s.participants.flatMap((p) => p.sharedItemIds ?? []));
  const lines = statuses.filter((x) => x.left > 0 && !sharedIds.has(x.item.itemId) && !x.share);
  return {
    lines,
    pence: lines.reduce((acc, x) => acc + x.item.unitPricePence * x.left, 0),
    claimedItemIds: [
      ...myClaimedItemIds,
      ...lines.flatMap((x) => Array<string>(x.left).fill(x.item.itemId)),
    ],
  };
}
