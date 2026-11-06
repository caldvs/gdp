import { feePence, owedPence, splitsOf } from '@gdp/core/lib/owed';
import type { Participant, ParticipantPaymentEntry, Session } from '../../types/sessions.js';

export { roundUpPence } from '@gdp/core/lib/owed';

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

/**
 * What a diner owes now, on a bill that may still be being claimed: the split
 * maths in packages/core/src/lib/owed.ts (the app shows the same), with the
 * API's splits (participants' `sharedItemIds` and `shareSettings`).
 */
type OwedBill = Parameters<typeof owedPence>[0];
const splitsIn = (session: Session) => splitsOf(session.participants, session.shareSettings ?? []);

/** The round-up this diner pays the lead on top of their share. The lead pays none. */
export const feeFor = (bill: OwedBill, session: Session, participant: Participant): number =>
  feePence(bill, session, participant, splitsIn(session));

/** Their share (items, service and tax, less any shared discount) and their round-up. */
export const computeOwedForParticipant = (
  bill: OwedBill,
  session: Session,
  participant: Participant,
): number => owedPence(bill, session, participant, splitsIn(session));
