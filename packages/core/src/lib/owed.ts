import type { components } from '../api';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];

/**
 * What a diner owes before the server has fixed `owedPence`: whole-unit
 * claims, plus each split's units of its line divided by the number of ways (ADR-0006), then
 * service + tax pro rata.
 * Mirrors paymentService.computeOwedForParticipant on the backend.
 */
export function projectSubtotalPence(session: Session, bill: Bill, userId: string): number {
  const p = session.participants.find((x) => x.userId === userId);
  const claimSub = (p?.claimedItemIds ?? []).reduce(
    (acc, id) => acc + (bill.items.find((x) => x.itemId === id)?.unitPricePence ?? 0),
    0,
  );
  const shareSub = (session.shares ?? []).reduce((acc, sh) => {
    if (!sh.userIds.includes(userId)) return acc;
    const item = bill.items.find((x) => x.itemId === sh.itemId);
    if (!item) return acc;
    return acc + sharePence(splitPricePence(item, sh), sh.userIds, sh.ways ?? sh.userIds.length, userId);
  }, 0);
  return claimSub + shareSub;
}

/** What a split costs in all: its units of the line (1 on older splits). */
export function splitPricePence(item: { unitPricePence: number }, share: { units?: number }): number {
  return item.unitPricePence * (share.units ?? 1);
}

/**
 * One person's part of a split: its price (see splitPricePence) divided into `ways`
 * equal spots, the leftover pennies going one each to the people in the
 * split in userId order. Spots nobody has taken yet aren't anyone's.
 * Mirrors splitShare in the API. Pass a userId not in the split to get
 * what joining would cost.
 */
export function sharePence(pricePence: number, userIds: readonly string[], ways: number, userId: string): number {
  const inSplit = userIds.includes(userId);
  const members = inSplit ? userIds : [...userIds, userId];
  const n = Math.max(ways, members.length);
  const base = Math.floor(pricePence / n);
  const remainder = pricePence - base * n;
  const rank = [...members].sort().indexOf(userId);
  return base + (rank < remainder ? 1 : 0);
}

/** The bill's shared discounts in all (8 Nov 2026); 0 on bills from before them. */
export function discountPence(bill: Pick<Bill, 'discounts'>): number {
  return (bill.discounts ?? []).reduce((acc, d) => acc + d.amountPence, 0);
}

/**
 * Service and tax per pound of items, less the shared discount, which is
 * taken off pro rata the same way. Mirrors owedBeforeRoundUp in the API's ledger.ts.
 */
export function extrasRate(bill: Bill): number {
  return bill.subtotalPence > 0
    ? (bill.serviceChargePence + bill.taxPence - discountPence(bill)) / bill.subtotalPence
    : 0;
}

/** A diner's part of the shared discount, on `itemsPence` of items (for showing it). */
export function discountPartPence(bill: Bill, itemsPence: number): number {
  return bill.subtotalPence > 0 ? Math.round((itemsPence * discountPence(bill)) / bill.subtotalPence) : 0;
}

/**
 * A guest's round-up (4 Nov 2026): what takes what they owe up to the next
 * whole pound, 0 when it's already a whole pound. Only on a bill shared on
 * the lead's hold. The lead is charged the round-ups at close, at most the
 * hold. Mirrors roundUpPence in the API's ledger.ts.
 */
export function roundUpPence(holdPence: number, owedPence: number): number {
  if (holdPence <= 0 || owedPence <= 0) return 0;
  return (100 - (owedPence % 100)) % 100;
}

/** What a diner owes before any round-up: their items plus their part of service and tax, less their part of any discount. */
function owedBeforeRoundUp(session: Session, bill: Bill, userId: string): number {
  return Math.round(projectSubtotalPence(session, bill, userId) * (1 + extrasRate(bill)));
}

/** The round-up a diner pays the lead on top of their share. The lead pays none. */
export function projectFeePence(session: Session, bill: Bill, userId: string): number {
  if (userId === session.creatorUserId) return 0;
  return roundUpPence(session.platformFeePence ?? 0, owedBeforeRoundUp(session, bill, userId));
}

/** What a diner owes: their items, their part of service and tax, and their round-up. */
export function projectOwedPence(session: Session, bill: Bill, userId: string): number {
  return owedBeforeRoundUp(session, bill, userId) + projectFeePence(session, bill, userId);
}
