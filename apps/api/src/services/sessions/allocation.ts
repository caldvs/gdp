import type { Bill } from '../../types/bills.js';
import type { Participant, Session } from '../../types/sessions.js';

/**
 * Computes `owedPence` for each participant such that the total reconciles
 * exactly to `bill.totalPence`. Claim semantics:
 *
 *   1. `claimedItemIds` may contain the same itemId multiple times — each
 *      occurrence claims one unit. The participant owes unitPricePence × N
 *      for each item they claimed N units of.
 *   2. `sharedItemIds` (ADR-0006) marks an item as split equally across all
 *      participants who have it in the list. The split covers `units` of
 *      the line (1 unless said); each sharer owes unitPricePence × units /
 *      ways (largest-remainder rounded so the sum is exact). The rest of a
 *      multi-quantity line is claimed one unit at a time.
 *   3. Apportion service charge and tax proportionally to each participant's
 *      pre-extras subtotal (claims + shares), using the largest-remainder
 *      method (Hare quota).
 *   4. Sum each participant's contributions.
 *
 * Throws an Error with `code = 'CLAIMS_INCOMPLETE'` and a list of itemIds
 * that are neither fully claimed nor have at least one sharer. Empty share
 * sets (userIds: []) are treated as "no share at all" per ADR-0006.
 */
/**
 * Split a price (one item's, or several of a line's) into `ways` equal
 * spots. The people who have joined take the first spots (sorted by userId, so the remainder penny
 * lands on the lowest userId as before); spots nobody has taken stay
 * unclaimed and are not returned. `ways` below the number of sharers
 * (legacy data) falls back to the sharer count.
 */
export function splitShare(
  pricePence: number,
  sharers: readonly string[],
  ways: number,
): Map<string, number> {
  const n = Math.max(ways, sharers.length);
  const keys = [...sharers].sort();
  const weights = new Map<string, number>(keys.map((u) => [u, 1]));
  // Open spots sort after any real userId.
  for (let i = keys.length; i < n; i++) weights.set(`\uffff#open${String(i).padStart(3, '0')}`, 1);
  const all = apportionByWeight(pricePence, weights);
  const out = new Map<string, number>();
  for (const u of keys) out.set(u, all.get(u) ?? 0);
  return out;
}

/**
 * #216: guests see what they owe, and can pay, once the lead opens payments.
 * A locked or closed bill is open; a bill still being set up isn't.
 */
export function paymentsAreOpen(session: Pick<Session, 'status' | 'paymentsOpenedAt'>): boolean {
  if (session.status === 'setup') return false;
  return session.status !== 'claiming' || !!session.paymentsOpenedAt;
}

/**
 * Lines not yet fully taken: some of the quantity nobody has claimed, or a
 * split with a spot open. Empty when every line is claimed (what computeOwed
 * needs, and what opens payments, #216).
 */
export function unclaimedItemIds(
  bill: Pick<Bill, 'items'>,
  participants: ReadonlyArray<
    Pick<Participant, 'userId' | 'claimedItemIds'> & { sharedItemIds?: readonly string[] }
  >,
  waysByItem: ReadonlyMap<string, number> = new Map(),
  unitsByItem: ReadonlyMap<string, number> = new Map(),
): string[] {
  const sharers = new Map<string, number>();
  for (const p of participants) {
    for (const itemId of p.sharedItemIds ?? []) sharers.set(itemId, (sharers.get(itemId) ?? 0) + 1);
  }
  const unclaimed: string[] = [];
  for (const item of bill.items) {
    const sharerCount = sharers.get(item.itemId) ?? 0;
    // A split is complete once every spot is taken.
    if (sharerCount > 0 && sharerCount < (waysByItem.get(item.itemId) ?? sharerCount)) {
      unclaimed.push(item.itemId);
      continue;
    }
    const shared = sharerCount > 0 ? (unitsByItem.get(item.itemId) ?? 1) : 0;
    const totalClaimed = participants.reduce(
      (sum, p) => sum + p.claimedItemIds.filter((id) => id === item.itemId).length,
      0,
    );
    if (totalClaimed + shared < item.quantity) unclaimed.push(item.itemId);
  }
  return unclaimed;
}

export function computeOwed(
  bill: Pick<Bill, 'items' | 'taxPence' | 'serviceChargePence' | 'totalPence'>,
  participants: ReadonlyArray<
    Pick<Participant, 'userId' | 'claimedItemIds'> & {
      // Optional in the function signature so older tests that predate
      // ADR-0006 don't have to add `sharedItemIds: []` everywhere. In
      // production code the field is always populated from the schema's
      // default.
      sharedItemIds?: readonly string[];
    }
  >,
  // itemId → how many ways the split is divided. Missing → split between
  // whoever has joined (pre-`ways` behaviour).
  waysByItem: ReadonlyMap<string, number> = new Map(),
  // itemId → how many of the line the split covers. Missing → 1.
  unitsByItem: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  const itemById = new Map(bill.items.map((it) => [it.itemId, it]));

  // Build the sharer set per itemId.
  const sharersByItem = new Map<string, string[]>();
  for (const p of participants) {
    for (const itemId of p.sharedItemIds ?? []) {
      const list = sharersByItem.get(itemId) ?? [];
      list.push(p.userId);
      sharersByItem.set(itemId, list);
    }
  }

  const unclaimed = unclaimedItemIds(bill, participants, waysByItem, unitsByItem);
  if (unclaimed.length > 0) {
    const err = new Error('CLAIMS_INCOMPLETE');
    (err as Error & { unclaimedItemIds: string[] }).unclaimedItemIds = unclaimed;
    throw err;
  }

  // Subtotal per user: claims first, then shares.
  const subtotalByUser = new Map<string, number>();
  for (const p of participants) {
    let subtotal = 0;
    for (const id of p.claimedItemIds) {
      const item = itemById.get(id);
      if (item) subtotal += item.unitPricePence;
    }
    subtotalByUser.set(p.userId, subtotal);
  }
  for (const [itemId, sharers] of sharersByItem) {
    const item = itemById.get(itemId);
    if (!item || sharers.length === 0) continue;
    const shares = splitShare(
      item.unitPricePence * (unitsByItem.get(itemId) ?? 1),
      sharers,
      waysByItem.get(itemId) ?? sharers.length,
    );
    for (const [userId, pence] of shares) {
      subtotalByUser.set(userId, (subtotalByUser.get(userId) ?? 0) + pence);
    }
  }

  const serviceShares = apportionByWeight(bill.serviceChargePence, subtotalByUser);
  const taxShares = apportionByWeight(bill.taxPence, subtotalByUser);

  const owed = new Map<string, number>();
  for (const [userId, subtotal] of subtotalByUser) {
    const owedPence = subtotal + (serviceShares.get(userId) ?? 0) + (taxShares.get(userId) ?? 0);
    owed.set(userId, owedPence);
  }

  return owed;
}

/**
 * Largest-remainder (Hare-quota) allocation of `total` pence across keys
 * weighted by their numeric weight. Sum of returned values equals `total`
 * exactly. Deterministic: ties broken by key sort order.
 */
export function apportionByWeight(
  total: number,
  weights: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (total === 0 || weights.size === 0) {
    for (const k of weights.keys()) out.set(k, 0);
    return out;
  }

  const sortedKeys = [...weights.keys()].sort();
  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);

  if (totalWeight === 0) {
    // Equal split when no weights — distribute pennies in key order.
    const base = Math.floor(total / sortedKeys.length);
    let remainder = total - base * sortedKeys.length;
    for (const k of sortedKeys) {
      const extra = remainder > 0 ? 1 : 0;
      out.set(k, base + extra);
      if (remainder > 0) remainder -= 1;
    }
    return out;
  }

  // Compute exact (fractional) share, then floor each.
  const exactByKey = new Map<string, number>();
  for (const k of sortedKeys) {
    exactByKey.set(k, ((weights.get(k) ?? 0) * total) / totalWeight);
  }

  let allocated = 0;
  for (const k of sortedKeys) {
    const floored = Math.floor(exactByKey.get(k) ?? 0);
    out.set(k, floored);
    allocated += floored;
  }

  let remainder = total - allocated;

  // Distribute remainder pence to keys with largest fractional parts.
  const ranked = sortedKeys
    .map((k) => ({ k, frac: (exactByKey.get(k) ?? 0) - Math.floor(exactByKey.get(k) ?? 0) }))
    .sort((a, b) => (a.frac === b.frac ? a.k.localeCompare(b.k) : b.frac - a.frac));

  for (const { k } of ranked) {
    if (remainder <= 0) break;
    out.set(k, (out.get(k) ?? 0) + 1);
    remainder -= 1;
  }

  return out;
}
