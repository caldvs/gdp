import type { Bill } from '../../types/bills.js';
import type { Participant } from '../../types/sessions.js';

/**
 * Computes `owedPence` for each participant such that the total reconciles
 * exactly to `bill.totalPence`. Uses a deterministic algorithm:
 *
 *   1. For each item, divide the cost (unitPrice × quantity) equally among
 *      its claimers. Remainder pennies go to claimers in userId-sorted order.
 *   2. Apportion service charge and tax proportionally to each participant's
 *      subtotal share, using the largest-remainder method (Hare quota).
 *   3. Sum each participant's contributions.
 *
 * Throws an Error with `code = 'CLAIMS_INCOMPLETE'` and a list of unclaimed
 * itemIds if any item has zero claimers.
 */
export function computeOwed(
  bill: Pick<Bill, 'items' | 'taxPence' | 'serviceChargePence' | 'totalPence'>,
  participants: ReadonlyArray<Pick<Participant, 'userId' | 'claimedItemIds'>>,
): Map<string, number> {
  const subtotalByUser = new Map<string, number>();
  for (const p of participants) {
    subtotalByUser.set(p.userId, 0);
  }

  const unclaimed: string[] = [];

  for (const item of bill.items) {
    const cost = item.unitPricePence * item.quantity;
    const claimers = participants
      .filter((p) => p.claimedItemIds.includes(item.itemId))
      .map((p) => p.userId)
      .sort();

    if (claimers.length === 0) {
      unclaimed.push(item.itemId);
      continue;
    }

    const baseShare = Math.floor(cost / claimers.length);
    const remainder = cost - baseShare * claimers.length;
    claimers.forEach((userId, i) => {
      const extra = i < remainder ? 1 : 0;
      subtotalByUser.set(userId, (subtotalByUser.get(userId) ?? 0) + baseShare + extra);
    });
  }

  if (unclaimed.length > 0) {
    const err = new Error('CLAIMS_INCOMPLETE');
    (err as Error & { unclaimedItemIds: string[] }).unclaimedItemIds = unclaimed;
    throw err;
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
