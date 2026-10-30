import type { components } from '../api';

type Session = components['schemas']['Session'];
type Bill = components['schemas']['Bill'];

/**
 * What a diner owes before the server has fixed `owedPence`: whole-unit
 * claims, plus shared items split equally with the remainder penny going
 * to the lowest userId (ADR-0006), then service + tax pro rata.
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
    const base = Math.floor(item.unitPricePence / sh.userIds.length);
    const remainder = item.unitPricePence - base * sh.userIds.length;
    return acc + base + (userId === [...sh.userIds].sort()[0] ? remainder : 0);
  }, 0);
  return claimSub + shareSub;
}

export function extrasRate(bill: Bill): number {
  return bill.subtotalPence > 0 ? (bill.serviceChargePence + bill.taxPence) / bill.subtotalPence : 0;
}

export function projectOwedPence(session: Session, bill: Bill, userId: string): number {
  return Math.round(projectSubtotalPence(session, bill, userId) * (1 + extrasRate(bill)));
}
