import type { Bill } from '../../types/bills.js';
import type { Participant } from '../../types/sessions.js';

/**
 * Computes `owedPence` for each participant such that the total reconciles
 * exactly to `bill.totalPence`. Claim semantics:
 *
 *   1. `claimedItemIds` may contain the same itemId multiple times — each
 *      occurrence claims one unit. The participant owes unitPricePence × N
 *      for each item they claimed N units of.
 *   2. `sharedItemIds` (ADR-0006) marks an item as split equally across all
 *      participants who have it in the list. Each sharer owes
 *      unitPricePence / N (largest-remainder rounded so the sum equals the
 *      unit price exactly).
 *   3. Apportion service charge and tax proportionally to each participant's
 *      pre-extras subtotal (claims + shares), using the largest-remainder
 *      method (Hare quota).
 *   4. Sum each participant's contributions.
 *
 * Throws an Error with `code = 'CLAIMS_INCOMPLETE'` and a list of itemIds
 * that are neither fully claimed nor have at least one sharer. Empty share
 * sets (userIds: []) are treated as "no share at all" per ADR-0006.
 */
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

  // Completeness: every unit of every item must be either claimed or
  // shared. With the v1 simplification only quantity-1 items can be
  // shared, so a non-empty sharer set covers the whole item.
  const unclaimed: string[] = [];
  for (const item of bill.items) {
    const hasSharers = (sharersByItem.get(item.itemId)?.length ?? 0) > 0;
    if (hasSharers) continue;
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
    // Equal split — apportionByWeight with all weights 1 reduces to an
    // even split with deterministic remainder placement on the lowest
    // userId. Reuse the same rounding algo we use for service / tax.
    const weights = new Map<string, number>(sharers.map((u) => [u, 1]));
    const shares = apportionByWeight(item.unitPricePence, weights);
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
