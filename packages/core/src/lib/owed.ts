import type { components } from '../api';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];

/**
 * What a diner owes before the server has fixed `owedPence`: whole-unit
 * claims, plus shared items split by the number of ways (ADR-0006), then service + tax pro rata.
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
    return acc + sharePence(item.unitPricePence, sh.userIds, sh.ways ?? sh.userIds.length, userId);
  }, 0);
  return claimSub + shareSub;
}

/**
 * One person's part of a shared item: the price divided into `ways`
 * equal spots, the leftover pennies going one each to the people in the
 * split in userId order. Spots nobody has taken yet aren't anyone's.
 * Mirrors splitShare in the API. Pass a userId not in the split to get
 * what joining would cost.
 */
export function sharePence(unitPricePence: number, userIds: readonly string[], ways: number, userId: string): number {
  const inSplit = userIds.includes(userId);
  const members = inSplit ? userIds : [...userIds, userId];
  const n = Math.max(ways, members.length);
  const base = Math.floor(unitPricePence / n);
  const remainder = unitPricePence - base * n;
  const rank = [...members].sort().indexOf(userId);
  return base + (rank < remainder ? 1 : 0);
}

export function extrasRate(bill: Bill): number {
  return bill.subtotalPence > 0 ? (bill.serviceChargePence + bill.taxPence) / bill.subtotalPence : 0;
}

/**
 * A guest's part of the lead's £1 hold (#166): the hold times their share
 * of the bill's items, rounded down. It's fixed by the bill, so it doesn't
 * depend on who joins or pays first, and the guests' parts never add up to
 * more than the hold. Mirrors feeSharePence in the API's ledger.ts.
 */
export function feeSharePence(holdPence: number, itemsPence: number, billSubtotalPence: number): number {
  if (holdPence <= 0 || itemsPence <= 0 || billSubtotalPence <= 0) return 0;
  return Math.floor((holdPence * Math.min(itemsPence, billSubtotalPence)) / billSubtotalPence);
}

/** The platform fee a diner pays back to the lead. The lead pays none. */
export function projectFeePence(session: Session, bill: Bill, userId: string): number {
  if (userId === session.creatorUserId) return 0;
  return feeSharePence(session.platformFeePence ?? 0, projectSubtotalPence(session, bill, userId), bill.subtotalPence);
}

/** What a diner owes: their items, their part of service and tax, and their part of the platform fee. */
export function projectOwedPence(session: Session, bill: Bill, userId: string): number {
  return Math.round(projectSubtotalPence(session, bill, userId) * (1 + extrasRate(bill))) + projectFeePence(session, bill, userId);
}
