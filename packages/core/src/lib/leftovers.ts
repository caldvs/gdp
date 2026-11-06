import type { components } from '../api';
import { paymentsAreOpen, unclaimedItemIds } from './owed';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];
type Participant = components['schemas']['Participant'];
type BillItem = components['schemas']['BillItem'];
type Share = NonNullable<Session['shares']>[number];

/**
 * One bill line and who has it. `left` is the units nobody has claimed; a
 * split counts as its units taken (one, unless it covers more of a line).
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
    taken.set(sh.itemId, (taken.get(sh.itemId) ?? 0) + (sh.units ?? 1));
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
 * What the lead's "I'll cover these" takes: every unclaimed unit outside a
 * split (`left` already leaves out a split's units; the API refuses a claim
 * on a split quantity-1 item). `claimedItemIds` is the lead's new full claim
 * list, one entry per unit, ready for a single setClaims call.
 */
export function coverLeftovers(
  s: Session,
  statuses: readonly ItemStatus[],
  myClaimedItemIds: readonly string[],
): { lines: ItemStatus[]; pence: number; claimedItemIds: string[] } {
  const sharedIds = new Set(s.participants.flatMap((p) => p.sharedItemIds ?? []));
  const splitOne = (x: ItemStatus) => x.item.quantity === 1 && (!!x.share || sharedIds.has(x.item.itemId));
  const lines = statuses.filter((x) => x.left > 0 && !splitOne(x));
  return {
    lines,
    pence: lines.reduce((acc, x) => acc + x.item.unitPricePence * x.left, 0),
    claimedItemIds: [
      ...myClaimedItemIds,
      ...lines.flatMap((x) => Array<string>(x.left).fill(x.item.itemId)),
    ],
  };
}

/**
 * Lines not yet fully taken: some of the quantity nobody has claimed, or a
 * split with a spot open (owed.ts, the API's own test).
 */
export function unclaimedLines(s: Session, b: Bill): BillItem[] {
  const open = new Set(unclaimedItemIds(b.items, s.participants, s.shares ?? []));
  return b.items.filter((it) => open.has(it.itemId));
}

/**
 * #216: guests see what they owe, and can pay, once every line is claimed,
 * the lead opens payments early, or the bill is locked or closed. Worked out
 * here (not read from the API's `paymentsOpen`) so an optimistic claim of the
 * last line opens them straight away. The API refuses a payment otherwise
 * (PAYMENTS_NOT_OPEN).
 */
export function paymentsOpen(s: Session, b: Bill): boolean {
  return paymentsAreOpen(s, allClaimed(s, b));
}

/** #216: the lead opened payments before every line was claimed. */
export function openedEarly(s: Session, b: Bill): boolean {
  return s.status === 'claiming' && !!s.paymentsOpenedAt && !allClaimed(s, b);
}

/**
 * #216: every unit and every spot in a split is claimed. Worked out here
 * rather than read from the API's `allClaimed` so an optimistic claim counts
 * straight away.
 */
export function allClaimed(s: Session, b: Bill): boolean {
  return unclaimedLines(s, b).length === 0;
}
