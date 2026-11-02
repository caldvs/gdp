import type { components } from '../api';

type Participant = components['schemas']['Participant'];
export type PaymentEntry = components['schemas']['ParticipantPaymentEntry'];

/**
 * A guest's payments to the lead (#121), mirroring the API's ledger.ts. A
 * guest can pay more than once: after paying they can claim more and top
 * up just the difference. The lead confirms each payment on its own.
 */
export type Ledger = {
  entries: PaymentEntry[];
  /** Sent: confirmed, or the guest has said they've sent it. */
  sentPence: number;
  /** Confirmed by the lead. */
  confirmedPence: number;
  /** Still to send: what they owe now less what they've sent. */
  duePence: number;
  /** Sent, waiting for the lead to confirm. */
  waiting: PaymentEntry[];
  /** Opened on the pay page, not sent yet. */
  draft?: PaymentEntry;
  /** Nothing to send and nothing waiting: good to leave. */
  settled: boolean;
};

export const isSent = (e: PaymentEntry): boolean =>
  e.status === 'succeeded' || (e.status === 'pending' && !!e.payerClaimedPaidAt);

/** Sessions from before top-ups have one `payment`, taken as what they owed. */
export function paymentsOf(p: Participant, owedPence: number): PaymentEntry[] {
  if (p.payments && p.payments.length > 0) return p.payments;
  const pay = p.payment;
  if (pay.status === 'pending') return [{ paymentId: pay.paymentId, amountPence: p.owedPence ?? owedPence, status: 'pending', ...(pay.payerClaimedPaidAt ? { payerClaimedPaidAt: pay.payerClaimedPaidAt } : {}) }];
  if (pay.status === 'succeeded') return [{ paymentId: pay.paymentId, amountPence: p.owedPence ?? owedPence, status: 'succeeded', paidAt: pay.paidAt }];
  return [];
}

export function ledger(p: Participant, owedPence: number): Ledger {
  const entries = paymentsOf(p, owedPence);
  const sentPence = entries.reduce((a, e) => (isSent(e) ? a + e.amountPence : a), 0);
  const confirmedPence = entries.reduce((a, e) => (e.status === 'succeeded' ? a + e.amountPence : a), 0);
  const waiting = entries.filter((e) => e.status === 'pending' && !!e.payerClaimedPaidAt);
  const draft = [...entries].reverse().find((e) => e.status === 'pending' && !e.payerClaimedPaidAt);
  const duePence = Math.max(0, owedPence - sentPence);
  return {
    entries,
    sentPence,
    confirmedPence,
    duePence,
    waiting,
    ...(draft ? { draft } : {}),
    settled: owedPence > 0 && duePence === 0 && waiting.length === 0,
  };
}
