import { splitShare } from '../sessions/allocation.js';
import type { Participant, ParticipantPaymentEntry, Session } from '../../types/sessions.js';

/**
 * A guest's payments to the lead (#121). A guest can pay more than once:
 * after their first payment they can claim more and pay just the
 * difference (a top-up). Each payment is confirmed by the lead on its own;
 * what anyone has paid never changes when others claim or pay.
 */

/**
 * The guest's payments, oldest first. Sessions from before #121 only have
 * the one `payment` slot; its amount wasn't kept there, so it's taken as
 * what they owed at the time (`owedFallback`).
 */
export function paymentsOf(p: Participant, owedFallback: number): ParticipantPaymentEntry[] {
  if (p.payments && p.payments.length > 0) return p.payments;
  const pay = p.payment;
  if (pay.status === 'pending') {
    return [
      {
        paymentId: pay.paymentId,
        amountPence: p.owedPence ?? owedFallback,
        status: 'pending',
        ...(pay.payerClaimedPaidAt ? { payerClaimedPaidAt: pay.payerClaimedPaidAt } : {}),
      },
    ];
  }
  if (pay.status === 'succeeded') {
    return [
      {
        paymentId: pay.paymentId,
        amountPence: p.owedPence ?? owedFallback,
        status: 'succeeded',
        paidAt: pay.paidAt,
      },
    ];
  }
  return [];
}

/**
 * Sent: confirmed by the lead, or the guest has said they've sent it. A
 * payment opened on the pay page but not yet sent is a draft: it doesn't
 * count, and is replaced if the guest changes their picks first.
 */
export const isSent = (e: ParticipantPaymentEntry): boolean =>
  e.status === 'succeeded' || (e.status === 'pending' && !!e.payerClaimedPaidAt);

/** Money the guest has sent (see isSent). */
export const sentPence = (entries: readonly ParticipantPaymentEntry[]): number =>
  entries.reduce((acc, e) => (isSent(e) ? acc + e.amountPence : acc), 0);

/** The payment opened on the pay page and not sent yet, if any. */
export const draftOf = (
  entries: readonly ParticipantPaymentEntry[],
): ParticipantPaymentEntry | undefined =>
  [...entries].reverse().find((e) => e.status === 'pending' && !e.payerClaimedPaidAt);

/**
 * The single `payment` the session has always shown for a guest: in flight
 * if any payment is, else paid if any was, else the last failure, else
 * unpaid. "Paid" alone doesn't mean nothing is owed: compare sentPence
 * with what they owe now.
 */
export function aggregatePayment(
  entries: readonly ParticipantPaymentEntry[],
): Participant['payment'] {
  const pending = [...entries].reverse().find((e) => e.status === 'pending');
  if (pending) {
    return {
      status: 'pending',
      paymentId: pending.paymentId,
      ...(pending.payerClaimedPaidAt ? { payerClaimedPaidAt: pending.payerClaimedPaidAt } : {}),
    };
  }
  const paid = [...entries].reverse().find((e) => e.status === 'succeeded');
  if (paid)
    return {
      status: 'succeeded',
      paymentId: paid.paymentId,
      paidAt: paid.paidAt ?? new Date().toISOString(),
    };
  const failed = entries[entries.length - 1];
  if (failed?.status === 'failed')
    return { status: 'failed', paymentId: failed.paymentId, reason: failed.reason ?? 'failed' };
  return { status: 'unpaid' };
}

/** Replace (or add) one payment and recompute the participant's `payment`. */
export function withPayment(
  p: Participant,
  entries: ParticipantPaymentEntry[],
  next: ParticipantPaymentEntry,
): Participant {
  const list = entries.some((e) => e.paymentId === next.paymentId)
    ? entries.map((e) => (e.paymentId === next.paymentId ? next : e))
    : [...entries, next];
  return { ...p, payments: list, payment: aggregatePayment(list) };
}

// Per-participant owed-amount calc tolerant of partial / unclaimed
// bills. Used when the lead hasn't locked claims yet — each diner pays
// for their CURRENT claims + a proportional share of service / tax.
// Mirrors the indicative math the frontend shows as the running total.
//
// Differs from `computeOwed` in allocation.ts: that one enforces the
// CLAIMS_INCOMPLETE invariant (every item must be claimed or shared)
// and apportions extras via largest-remainder rounding for exact
// reconciliation. The trust-based path can't enforce completeness —
// some items may legitimately be unclaimed at pay time — so we use
// the simpler ratio approach and accept slight rounding drift across
// participants (a few pennies, well within manual-mode tolerance).
type OwedBill = {
  items: ReadonlyArray<{ itemId: string; unitPricePence: number }>;
  subtotalPence: number;
  serviceChargePence: number;
  taxPence: number;
};

/**
 * A diner's items: whole-unit claims plus their part of each split. Share
 * subtotal (ADR-0006): the split's units of the line divided equally,
 * remainder pennies to the lowest userIds.
 */
export function itemsPenceFor(bill: OwedBill, session: Session, participant: Participant): number {
  let claimSub = 0;
  for (const id of participant.claimedItemIds) {
    const item = bill.items.find((it) => it.itemId === id);
    if (item) claimSub += item.unitPricePence;
  }
  let shareSub = 0;
  for (const itemId of participant.sharedItemIds ?? []) {
    const item = bill.items.find((it) => it.itemId === itemId);
    if (!item) continue;
    const sharers = session.participants
      .filter((p) => (p.sharedItemIds ?? []).includes(itemId))
      .map((p) => p.userId);
    if (sharers.length === 0) continue;
    const st = session.shareSettings?.find((s) => s.itemId === itemId);
    const ways = st?.ways ?? sharers.length;
    const price = item.unitPricePence * (st?.units ?? 1);
    shareSub += splitShare(price, sharers, ways).get(participant.userId) ?? 0;
  }
  return claimSub + shareSub;
}

/** The platform fee this diner pays back to the lead (#166). The lead pays none. */
export function feeFor(bill: OwedBill, session: Session, participant: Participant): number {
  if (participant.userId === session.creatorUserId) return 0;
  return feeSharePence(
    session.platformFeePence ?? 0,
    itemsPenceFor(bill, session, participant),
    bill.subtotalPence,
  );
}

export function computeOwedForParticipant(
  bill: OwedBill,
  session: Session,
  participant: Participant,
): number {
  const items = itemsPenceFor(bill, session, participant);
  const extras = bill.serviceChargePence + bill.taxPence;
  const extrasRate = bill.subtotalPence > 0 ? extras / bill.subtotalPence : 0;
  return Math.round(items * (1 + extrasRate)) + feeFor(bill, session, participant);
}

/**
 * A guest's part of the lead's £1 hold (#166): the hold times their share
 * of the bill's items, rounded down. Fixed by the bill, so it doesn't depend
 * on who joins or pays first, and the guests' parts never add up to more
 * than the hold. Mirrors feeSharePence in packages/core/src/lib/owed.ts.
 */
export function feeSharePence(
  holdPence: number,
  itemsPence: number,
  billSubtotalPence: number,
): number {
  if (holdPence <= 0 || itemsPence <= 0 || billSubtotalPence <= 0) return 0;
  return Math.floor((holdPence * Math.min(itemsPence, billSubtotalPence)) / billSubtotalPence);
}
