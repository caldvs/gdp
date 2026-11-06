/**
 * The split maths, once, for the API and the app: what each person's items
 * come to, their part of service, tax and any shared discount, round-ups,
 * and which lines are still unclaimed. The API imports this file
 * (`@gdp/core/lib/owed`), so it stays pure: no imports, no I/O, no React.
 *
 * Splits (ADR-0006) are given as `Split`s: the people in it, its ways (spots,
 * some maybe open) and how many of the line it covers. The API builds them
 * from participants' `sharedItemIds` and the session's `shareSettings`
 * (`splitsOf`); the app reads them from the session's `shares`.
 */

export type Split = {
  itemId: string;
  userIds: readonly string[];
  /** Spots in the split; missing: one per person in it (older splits). */
  ways?: number;
  /** How many of the line it covers; missing: 1. */
  units?: number;
};

type PricedItem = { itemId: string; unitPricePence: number };
type Line = PricedItem & { quantity: number };
type Diner = { userId: string; claimedItemIds: readonly string[] };
/** The bill's money, enough for the extras and discounts. */
export type BillTotals = {
  subtotalPence: number;
  serviceChargePence: number;
  taxPence: number;
  /** Shared discounts (8 Nov 2026), taken off pro rata; none on older bills. */
  discounts?: ReadonlyArray<{ amountPence: number }> | null;
};

// ---- Apportioning pennies ----

/**
 * Largest-remainder (Hare-quota) allocation of `total` pence across keys
 * weighted by their numeric weight. Sum of returned values equals `total`
 * exactly. Deterministic: ties broken by key sort order.
 */
export function apportionByWeight(total: number, weights: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (total === 0 || weights.size === 0) {
    for (const k of weights.keys()) out.set(k, 0);
    return out;
  }

  const sortedKeys = [...weights.keys()].sort();
  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0);

  if (totalWeight === 0) {
    // Equal split when no weights: pennies in key order.
    const base = Math.floor(total / sortedKeys.length);
    let remainder = total - base * sortedKeys.length;
    for (const k of sortedKeys) {
      out.set(k, base + (remainder > 0 ? 1 : 0));
      if (remainder > 0) remainder -= 1;
    }
    return out;
  }

  // Exact (fractional) shares, floored; the remainder goes to the largest fractions.
  const exact = new Map(sortedKeys.map((k) => [k, (weights.get(k)! * total) / totalWeight]));
  let allocated = 0;
  for (const k of sortedKeys) {
    const floored = Math.floor(exact.get(k)!);
    out.set(k, floored);
    allocated += floored;
  }
  let remainder = total - allocated;
  const ranked = sortedKeys
    .map((k) => ({ k, frac: exact.get(k)! - Math.floor(exact.get(k)!) }))
    .sort((a, b) => (a.frac === b.frac ? a.k.localeCompare(b.k) : b.frac - a.frac));
  for (const { k } of ranked) {
    if (remainder <= 0) break;
    out.set(k, out.get(k)! + 1);
    remainder -= 1;
  }
  return out;
}

// ---- Splits ----

/**
 * Split a price (one item's, or several of a line's) into `ways` equal
 * spots. The people who have joined take the first spots (sorted by userId,
 * so the remainder penny lands on the lowest userId); spots nobody has taken
 * stay unclaimed and are not returned. `ways` below the number of sharers
 * (legacy data) falls back to the sharer count.
 */
export function splitShare(pricePence: number, sharers: readonly string[], ways: number): Map<string, number> {
  const n = Math.max(ways, sharers.length);
  const keys = [...sharers].sort();
  const weights = new Map<string, number>(keys.map((u) => [u, 1]));
  // Open spots sort after any real userId.
  for (let i = keys.length; i < n; i++) weights.set(`￿#open${String(i).padStart(3, '0')}`, 1);
  const all = apportionByWeight(pricePence, weights);
  return new Map(keys.map((u) => [u, all.get(u)!]));
}

/**
 * One person's part of a split (see splitShare). Pass a userId not in the
 * split to get what joining would cost.
 */
export function sharePence(pricePence: number, userIds: readonly string[], ways: number, userId: string): number {
  const members = userIds.includes(userId) ? userIds : [...userIds, userId];
  return splitShare(pricePence, members, ways).get(userId)!;
}

/** What a split costs in all: its units of the line (1 on older splits). */
export function splitPricePence(item: { unitPricePence: number }, share: { units?: number }): number {
  return item.unitPricePence * (share.units ?? 1);
}

/**
 * The API's way of keeping splits (participants' `sharedItemIds`, ways and
 * units in `shareSettings`) as `Split`s, in the order people joined them.
 */
export function splitsOf(
  participants: ReadonlyArray<{ userId: string; sharedItemIds?: readonly string[] }>,
  settings: ReadonlyArray<{ itemId: string; ways: number; units?: number }> = [],
): Split[] {
  const byItem = new Map<string, string[]>();
  for (const p of participants) {
    for (const itemId of p.sharedItemIds ?? []) byItem.set(itemId, [...(byItem.get(itemId) ?? []), p.userId]);
  }
  return [...byItem].map(([itemId, userIds]) => {
    const st = settings.find((s) => s.itemId === itemId);
    return { itemId, userIds, ...(st ? { ways: st.ways, units: st.units ?? 1 } : {}) };
  });
}

// ---- Claims ----

/**
 * Lines not yet fully taken: some of the quantity nobody has claimed, or a
 * split with a spot open. Empty when every line is claimed (what computeOwed
 * needs, and what opens payments, #216). A split with nobody in it is no split.
 */
export function unclaimedItemIds(items: readonly Line[], diners: readonly Diner[], splits: readonly Split[]): string[] {
  const unclaimed: string[] = [];
  for (const item of items) {
    const sp = splits.find((s) => s.itemId === item.itemId && s.userIds.length > 0);
    if (sp && sp.userIds.length < (sp.ways ?? sp.userIds.length)) {
      unclaimed.push(item.itemId);
      continue;
    }
    const shared = sp ? (sp.units ?? 1) : 0;
    const claimed = diners.reduce((sum, d) => sum + d.claimedItemIds.filter((id) => id === item.itemId).length, 0);
    if (claimed + shared < item.quantity) unclaimed.push(item.itemId);
  }
  return unclaimed;
}

/**
 * #216: guests see what they owe, and can pay, once every line is claimed or
 * the lead opens payments early. A locked or closed bill is open; a bill
 * still being set up isn't.
 */
export function paymentsAreOpen(session: { status: string; paymentsOpenedAt?: string | null }, allClaimed: boolean): boolean {
  if (session.status === 'setup') return false;
  return session.status !== 'claiming' || !!session.paymentsOpenedAt || allClaimed;
}

// ---- What each person owes ----

/** A diner's items: whole-unit claims plus their part of each split they're in. */
export function itemsPence(items: readonly PricedItem[], diner: Diner, splits: readonly Split[]): number {
  const price = (id: string) => items.find((it) => it.itemId === id)?.unitPricePence;
  const claims = diner.claimedItemIds.reduce((acc, id) => acc + (price(id) ?? 0), 0);
  const parts = splits.reduce((acc, sp) => {
    const item = items.find((it) => it.itemId === sp.itemId);
    if (!item || !sp.userIds.includes(diner.userId)) return acc;
    return acc + sharePence(splitPricePence(item, sp), sp.userIds, sp.ways ?? sp.userIds.length, diner.userId);
  }, 0);
  return claims + parts;
}

/** The bill's shared discounts in all (8 Nov 2026); 0 on bills from before them. */
export function discountPence(bill: Pick<BillTotals, 'discounts'>): number {
  return (bill.discounts ?? []).reduce((acc, d) => acc + d.amountPence, 0);
}

/** The bill to pay: items, service and tax, less the shared discounts. */
export function billTotalPence(bill: BillTotals): number {
  return bill.subtotalPence + bill.serviceChargePence + bill.taxPence - discountPence(bill);
}

/**
 * What `items` pence of the bill comes to with its part of service and tax,
 * less its part of any shared discount, rounded down to the penny (8 Nov
 * 2026, penny-exact): a guest's amount depends only on what they had, so it
 * never moves when someone else claims, and the lead takes the pennies left
 * over (see sharesOf).
 */
export function withExtrasPence(bill: BillTotals, items: number): number {
  if (items <= 0) return 0;
  if (bill.subtotalPence <= 0) return items;
  return Math.floor((items * billTotalPence(bill)) / bill.subtotalPence);
}

/**
 * Everyone's share, adding up to the bill exactly: each guest and what nobody
 * claimed get withExtrasPence of their items; the lead gets the rest of the
 * bill. `itemsByUser` must include the lead.
 */
export function sharesOf(
  bill: BillTotals,
  itemsByUser: ReadonlyMap<string, number>,
  leadUserId: string,
  nobodyItems = 0,
): { byUser: Map<string, number>; nobody: number } {
  const byUser = new Map<string, number>();
  const nobody = withExtrasPence(bill, nobodyItems);
  let others = nobody;
  for (const [u, items] of itemsByUser) {
    if (u === leadUserId) continue;
    const share = withExtrasPence(bill, items);
    byUser.set(u, share);
    others += share;
  }
  byUser.set(leadUserId, billTotalPence(bill) - others);
  return { byUser, nobody };
}

/** Service and tax per pound of items, less the shared discount, taken off pro rata. */
export function extrasRate(bill: BillTotals): number {
  return bill.subtotalPence > 0
    ? (bill.serviceChargePence + bill.taxPence - discountPence(bill)) / bill.subtotalPence
    : 0;
}

/**
 * A diner's part of the shared discount, on `itemsPence` of items, for showing
 * it. Rounded up, so service shown as (share − items + discount) is never
 * below zero.
 */
export function discountPartPence(bill: BillTotals, items: number): number {
  return bill.subtotalPence > 0 && items > 0 ? Math.ceil((items * discountPence(bill)) / bill.subtotalPence) : 0;
}

/**
 * A guest's round-up (4 Nov 2026): what takes what they owe up to the next
 * whole pound, 0 when it's already a whole pound. Only on a bill shared on
 * the lead's hold. The lead is charged the round-ups at close, at most the hold.
 */
export function roundUpPence(holdPence: number, owedPence: number): number {
  if (holdPence <= 0 || owedPence <= 0) return 0;
  return (100 - (owedPence % 100)) % 100;
}

type Table = { creatorUserId: string; platformFeePence?: number | null; participants: readonly Diner[] };
type OwedBill = BillTotals & { items: readonly PricedItem[] };

/**
 * Everyone's share of the bill as it stands, to the penny (sharesOf): the
 * diners at the table (plus `extra`, someone not in it yet), and what nobody
 * has claimed, which goes on the lead.
 */
function sharesAt(bill: OwedBill, table: Table, splits: readonly Split[], extra?: Diner) {
  const diners = extra && !table.participants.some((p) => p.userId === extra.userId) ? [...table.participants, extra] : table.participants;
  const items = new Map(diners.map((d) => [d.userId, itemsPence(bill.items, d, splits)]));
  if (!items.has(table.creatorUserId)) items.set(table.creatorUserId, 0);
  const claimed = [...items.values()].reduce((a, b) => a + b, 0);
  return sharesOf(bill, items, table.creatorUserId, Math.max(0, bill.subtotalPence - claimed));
}

/**
 * What a diner owes before any round-up: their items, plus their part of
 * service and tax, less their part of any shared discount (withExtrasPence);
 * for the lead, the rest of the bill. Works on a bill still being claimed, so
 * it's what a payment is for, and what the bill is locked at.
 */
export function owedBeforeRoundUp(bill: OwedBill, table: Table, diner: Diner, splits: readonly Split[]): number {
  if (diner.userId !== table.creatorUserId) return withExtrasPence(bill, itemsPence(bill.items, diner, splits));
  return sharesAt(bill, table, splits, diner).byUser.get(diner.userId)!;
}

/** What nobody has claimed, with its service and tax: it goes on the lead. */
export function nobodyPence(bill: OwedBill, table: Table, splits: readonly Split[]): number {
  return sharesAt(bill, table, splits).nobody;
}

/** The round-up a diner pays the lead on top of their share. The lead pays none. */
export function feePence(bill: OwedBill, table: Table, diner: Diner, splits: readonly Split[]): number {
  if (diner.userId === table.creatorUserId) return 0;
  return roundUpPence(table.platformFeePence ?? 0, owedBeforeRoundUp(bill, table, diner, splits));
}

/** What a diner owes now: their share and their round-up. */
export function owedPence(bill: OwedBill, table: Table, diner: Diner, splits: readonly Split[]): number {
  return owedBeforeRoundUp(bill, table, diner, splits) + feePence(bill, table, diner, splits);
}

/**
 * Everyone's share of a fully claimed bill, adding up to its total to the
 * penny (round-ups not included), exactly what owedBeforeRoundUp gives each
 * of them. Throws an Error 'CLAIMS_INCOMPLETE' with `unclaimedItemIds`
 * otherwise.
 */
export function computeOwed(bill: OwedBill & { items: readonly Line[] }, table: Table, splits: readonly Split[]): Map<string, number> {
  const diners = table.participants;
  const unclaimed = unclaimedItemIds(bill.items, diners, splits);
  if (unclaimed.length > 0) {
    const err = new Error('CLAIMS_INCOMPLETE');
    (err as Error & { unclaimedItemIds: string[] }).unclaimedItemIds = unclaimed;
    throw err;
  }
  const { byUser } = sharesAt(bill, table, splits);
  return new Map(diners.map((d) => [d.userId, byUser.get(d.userId)!]));
}

// ---- The app's projections, from the session as the API returns it ----

type ClientSession = Table & {
  participants: ReadonlyArray<Diner>;
  shares?: ReadonlyArray<Split> | null;
};

const dinerIn = (session: ClientSession, userId: string): Diner =>
  session.participants.find((p) => p.userId === userId) ?? { userId, claimedItemIds: [] };

/** A diner's items before the server has fixed `owedPence`. */
export function projectSubtotalPence(session: ClientSession, bill: OwedBill, userId: string): number {
  return itemsPence(bill.items, dinerIn(session, userId), session.shares ?? []);
}

/** The round-up a diner pays the lead on top of their share. The lead pays none. */
export function projectFeePence(session: ClientSession, bill: OwedBill, userId: string): number {
  return feePence(bill, session, dinerIn(session, userId), session.shares ?? []);
}

/** What a diner owes: what the API charges them for a payment now. */
export function projectOwedPence(session: ClientSession, bill: OwedBill, userId: string): number {
  return owedPence(bill, session, dinerIn(session, userId), session.shares ?? []);
}
