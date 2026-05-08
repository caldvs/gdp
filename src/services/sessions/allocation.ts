import type { Bill } from '../../types/bills.js';
import type { Participant } from '../../types/sessions.js';

/**
 * Computes `owedPence` for each participant such that the total reconciles
 * exactly to `bill.totalPence`. Per-unit claim semantics:
 *
 *   1. claimedItemIds may contain the same itemId multiple times — each
 *      occurrence claims one unit. Each user owes unitPricePence × N for
 *      each item they claimed N units of.
 *   2. Apportion service charge and tax proportionally to each participant's
 *      subtotal, using the largest-remainder method (Hare quota).
 *   3. Sum each participant's contributions.
 *
 * Throws an Error with `code = 'CLAIMS_INCOMPLETE'` and a list of itemIds
 * whose total claim count across all participants is less than item.quantity.
 */
export function computeOwed(
  bill: Pick<Bill, 'items' | 'taxPence' | 'serviceChargePence' | 'totalPence'>,
  participants: ReadonlyArray<Pick<Participant, 'userId' | 'claimedItemIds'>>,
): Map<string, number> {
  const itemById = new Map(bill.items.map((it) => [it.itemId, it]));

  // Per-unit completeness: for each item, total claim count across all
  // participants must equal item.quantity. Anything short → unclaimed.
  const unclaimed: string[] = [];
  for (const item of bill.items) {
    const totalClaimed = participants.reduce(
      (sum, p) => sum + p.claimedItemIds.filter((id) => id === item.itemId).length,
      0,
    );
    if (totalClaimed < item.quantity) unclaimed.push(item.itemId);
  }
  if (unclaimed.length > 0) {
    const err = new Error('CLAIMS_INCOMPLETE');
    (err as Error & { unclaimedItemIds: string[] }).unclaimedItemIds = unclaimed;
    throw err;
  }

  // Subtotal per user: sum of unitPricePence for each occurrence in their claims.
  const subtotalByUser = new Map<string, number>();
  for (const p of participants) {
    let subtotal = 0;
    for (const id of p.claimedItemIds) {
      const item = itemById.get(id);
      if (item) subtotal += item.unitPricePence;
    }
    subtotalByUser.set(p.userId, subtotal);
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
