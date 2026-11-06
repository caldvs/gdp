import { v7 as uuidv7 } from 'uuid';
import {
  aggregatePayment,
  computeOwedForParticipant,
  draftOf,
  isSent,
  paymentsOf,
  sentPence,
  withPayment,
} from './ledger.js';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { paymentStore } from '../../storage/paymentStore.js';
import { userStore } from '../../storage/userStore.js';
import { billStore } from '../../storage/billStore.js';
import { paymentsAreOpen } from '../sessions/allocation.js';
import { retryOnConflict } from '../../storage/conflict.js';
import type { Logger } from '../../logging/logger.js';
import type { VerifiedCaller } from '../../context/caller.js';
import type { Participant, Session } from '../../types/sessions.js';
import type { Payment, PaymentEvent, PaymentInstructions } from '../../types/payments.js';
import type { PayoutAccount } from '../../types/users.js';

// The guest's row changed under us more times than retrying could absorb.
const busy = () =>
  new AppError('SESSION_INVALID_STATE', 'Something changed at the same moment — try again');

export const paymentService = {
  async initiate(input: {
    caller: VerifiedCaller;
    sessionId: string;
    idempotencyKey: string;
    logger?: Logger;
  }): Promise<{ payment: Payment; instructions: PaymentInstructions }> {
    // Each try re-reads the guest's row; the write lands only over that read.
    return retryOnConflict(async () => {
      const session = await sessionStore.get(input.sessionId);
      if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
      const participant = session.participants.find((p) => p.userId === input.caller.userId);
      if (!participant) {
        throw new AppError('SESSION_NOT_FOUND', 'Session not found');
      }
      // Trust-based model: a guest can pay as soon as they're confident
      // in their picks — no need for the lead to "lock claims" first.
      // We accept both `claiming` (no lock yet) and `paying` (post-lock).
      // `settled` is also allowed: the lead can close the bill from the
      // table before everyone has paid, and a late guest should still be
      // able to settle up. Setup / abandoned remain hard-rejected.
      if (
        session.status !== 'paying' &&
        session.status !== 'claiming' &&
        session.status !== 'settled'
      ) {
        throw new AppError('SESSION_INVALID_STATE', `Session is ${session.status}; can't pay`);
      }
      if (participant.userId === session.collectorUserId) {
        throw new AppError('SESSION_INVALID_STATE', 'Collector does not pay themselves');
      }
      assertPaymentsOpen(session);
      // #121: a guest can pay more than once. Each payment is for what they
      // owe now less what they've already sent (in flight or confirmed), so
      // a guest who claimed more after paying tops up just the difference.
      // Payments can overlap: the lead confirms each one on its own.
      const owed = await owedNow(session, participant);
      let entries = paymentsOf(participant, owed);
      const duePence = owed - sentPence(entries);
      if (duePence <= 0) {
        throw new AppError(
          'SESSION_INVALID_STATE',
          sentPence(entries) > 0 ? 'Nothing more to pay' : 'Nothing claimed yet',
        );
      }
      // A payment opened earlier and not sent yet: reuse it if it's still
      // for the right amount (same reference and details), else
      // close it and open one for the new amount.
      const draft = draftOf(entries);
      if (draft) {
        const old = await paymentStore.get(draft.paymentId);
        if (old && old.status === 'pending' && old.amountPence === duePence) {
          const collectorNow = await userStore.get(session.collectorUserId);
          return {
            payment: old,
            instructions: buildManualInstructions({
              payoutAccount: collectorNow?.payoutAccount,
              reference: `gdp-${session.sessionId.slice(0, 8)}`,
              amountPence: old.amountPence,
            }),
          };
        }
        if (old && old.status === 'pending') {
          await paymentStore.put({
            ...old,
            status: 'failed',
            events: [
              ...old.events,
              {
                at: new Date().toISOString(),
                from: 'pending',
                to: 'failed',
                source: 'system',
                note: 'superseded: amount changed before it was sent',
              },
            ],
          });
        }
        entries = entries.filter((e) => e.paymentId !== draft.paymentId);
      }

      // The guest pays from their own banking app and the lead confirms it
      // arrived (/confirm). Per ADR-0002 the lead's bank details normally live
      // on their device and reach guests in the join QR: if the server has
      // them they're echoed back (with Monzo/Revolut links), otherwise the
      // client shows the ones from the QR.
      const collector = await userStore.get(session.collectorUserId);
      const paymentId = uuidv7();
      const reference = `gdp-${session.sessionId.slice(0, 8)}`;
      const amountPence = duePence;
      const instructions = buildManualInstructions({
        payoutAccount: collector?.payoutAccount,
        reference,
        amountPence,
      });

      const now = new Date().toISOString();
      const payment: Payment = {
        paymentId,
        sessionId: session.sessionId,
        payerUserId: participant.userId,
        collectorUserId: session.collectorUserId,
        amountPence,
        currency: 'GBP',
        status: 'pending',
        idempotencyKey: input.idempotencyKey,
        events: [{ at: now, from: 'pending', to: 'pending', source: 'system', note: 'created' }],
        createdAt: now,
      };

      const updatedParticipant = withPayment(participant, entries, {
        paymentId,
        amountPence,
        status: 'pending',
      });

      await paymentStore.applyUpdate({ payment, participant: updatedParticipant });

      return { payment, instructions };
    }, busy);
  },

  /**
   * Payer claims they've sent the money via their bank app. Idempotent —
   * concurrent claims both end up with the same canonical timestamp (the
   * earlier write wins via DDB's `if_not_exists`). Doesn't advance state;
   * it's purely a UX signal so the lead knows which pending payments are
   * awaiting confirmation.
   */
  async markPaidByPayer(input: { caller: VerifiedCaller; paymentId: string }): Promise<Payment> {
    // Read first to enforce auth + state guards. The actual write is a
    // separate atomic UpdateExpression so two concurrent claims can't
    // race past the `payerClaimedPaidAt` check and write different
    // timestamps.
    const payment = await paymentStore.get(input.paymentId);
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found');
    if (payment.payerUserId !== input.caller.userId) {
      throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found');
    }
    if (payment.status !== 'pending') {
      throw new AppError(
        'SESSION_INVALID_STATE',
        `Cannot mark a payment as paid in status ${payment.status}`,
      );
    }

    const now = new Date().toISOString();
    // Atomic: SET payerClaimedPaidAt = if_not_exists(payerClaimedPaidAt, :now).
    // Returned value is the canonical timestamp — ours if we won the
    // race, the earlier writer's if we lost.
    const updated = await paymentStore.setPayerClaimedPaidAt(input.paymentId, now);
    // Mirror the canonical timestamp onto the participant's payment
    // subdocument so the lead's session view shows it without re-fetching
    // the payment row. The mirror is condition-gated on participant still
    // being `pending` — if they've already moved on, the mirror is a
    // no-op. The payment row is the truth; the mirror is best-effort UX.
    if (updated.payerClaimedPaidAt) {
      await retryOnConflict(async () => {
        const session = await sessionStore.get(payment.sessionId);
        const participant = session?.participants.find((p) => p.userId === payment.payerUserId);
        if (participant) {
          const entries = paymentsOf(participant, payment.amountPence);
          const entry = entries.find((e) => e.paymentId === payment.paymentId);
          if (entry?.status === 'pending' && !entry.payerClaimedPaidAt) {
            await sessionStore.putParticipant(
              payment.sessionId,
              withPayment(participant, entries, {
                ...entry,
                payerClaimedPaidAt: updated.payerClaimedPaidAt,
              }),
            );
          }
        }
      }, busy);
    }
    return updated;
  },

  /**
   * The lead saw the money land (a banking app notification), so everything
   * this guest owes now is received, whether or not they said they'd paid:
   * what they say they've sent is confirmed, a payment opened but not sent
   * is closed (its amount may be stale), and the rest becomes one more
   * payment, already confirmed. Nothing left to collect: no change.
   */
  async markReceived(input: {
    caller: VerifiedCaller;
    sessionId: string;
    userId: string;
    logger?: Logger;
  }): Promise<void> {
    return retryOnConflict(async () => {
      const session = await sessionStore.get(input.sessionId);
      if (!session || session.collectorUserId !== input.caller.userId) {
        throw new AppError('SESSION_NOT_FOUND', 'Session not found');
      }
      if (
        session.status !== 'claiming' &&
        session.status !== 'paying' &&
        session.status !== 'settled'
      ) {
        throw new AppError('SESSION_INVALID_STATE', `Session is ${session.status}`);
      }
      const guest = session.participants.find((p) => p.userId === input.userId);
      if (!guest || guest.userId === session.collectorUserId) {
        throw new AppError('SESSION_NOT_FOUND', 'Guest not found');
      }

      const owed = await owedNow(session, guest);
      const now = new Date().toISOString();
      const changed: Payment[] = [];
      let entries = paymentsOf(guest, owed);
      for (const entry of entries.filter((e) => e.status === 'pending')) {
        const payment = await paymentStore.get(entry.paymentId);
        if (!payment || payment.status !== 'pending') continue;
        const sent = isSent(entry);
        changed.push({
          ...payment,
          status: sent ? 'succeeded' : 'failed',
          events: [
            ...payment.events,
            {
              at: now,
              from: 'pending',
              to: sent ? 'succeeded' : 'failed',
              source: 'api',
              note: sent ? 'collector marked received' : 'superseded: collector marked received',
            },
          ],
        });
        entries = entries.map((e) =>
          e.paymentId !== entry.paymentId
            ? e
            : sent
              ? { ...e, status: 'succeeded', paidAt: now }
              : { ...e, status: 'failed', reason: 'superseded' },
        );
      }

      const rest = owed - sentPence(entries);
      let updated: Participant = guest;
      if (changed.length > 0) {
        updated = { ...guest, payments: entries, payment: aggregatePayment(entries) };
      }
      if (rest > 0) {
        const paymentId = uuidv7();
        changed.push({
          paymentId,
          sessionId: session.sessionId,
          payerUserId: guest.userId,
          collectorUserId: session.collectorUserId,
          amountPence: rest,
          currency: 'GBP',
          status: 'succeeded',
          // Not from a client request; unique per payment like a real key.
          idempotencyKey: `received:${paymentId}`,
          events: [
            {
              at: now,
              from: 'pending',
              to: 'succeeded',
              source: 'api',
              note: 'collector marked received',
            },
          ],
          createdAt: now,
        });
        updated = withPayment(updated, entries, {
          paymentId,
          amountPence: rest,
          status: 'succeeded',
          paidAt: now,
        });
      }
      if (changed.length === 0) return;

      await paymentStore.applyUpdates({
        sessionId: session.sessionId,
        payments: changed,
        participant: updated,
      });
      maybeSettleSession(
        { ...session, participants: replaceParticipant(session.participants, updated) },
        input.logger,
      );
    }, busy);
  },

  /** The collector marks a guest payment as received. */
  async confirmManual(input: {
    caller: VerifiedCaller;
    paymentId: string;
    logger?: Logger;
  }): Promise<Payment> {
    return retryOnConflict(async () => {
      const payment = await paymentStore.get(input.paymentId);
      if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found');
      if (payment.collectorUserId !== input.caller.userId) {
        throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found');
      }
      if (payment.status === 'succeeded') {
        // Idempotent: already confirmed.
        return payment;
      }
      if (payment.status !== 'pending') {
        throw new AppError(
          'SESSION_INVALID_STATE',
          `Cannot confirm a payment in status ${payment.status}`,
        );
      }

      const session = await sessionStore.get(payment.sessionId);
      if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
      const participant = session.participants.find((p) => p.userId === payment.payerUserId);
      if (!participant) throw new AppError('SESSION_NOT_FOUND', 'Participant not found');

      const now = new Date().toISOString();
      const event: PaymentEvent = {
        at: now,
        from: payment.status,
        to: 'succeeded',
        source: 'api',
        note: 'collector confirmed manual receipt',
      };
      const updatedPayment: Payment = {
        ...payment,
        status: 'succeeded',
        events: [...payment.events, event],
      };
      const entries = paymentsOf(participant, payment.amountPence);
      const prev = entries.find((e) => e.paymentId === payment.paymentId);
      const updatedParticipant = withPayment(participant, entries, {
        ...(prev ?? { paymentId: payment.paymentId, amountPence: payment.amountPence }),
        status: 'succeeded',
        paidAt: now,
      });
      await paymentStore.applyUpdate({ payment: updatedPayment, participant: updatedParticipant });

      maybeSettleSession(
        { ...session, participants: replaceParticipant(session.participants, updatedParticipant) },
        input.logger,
      );

      return updatedPayment;
    }, busy);
  },

  async get(input: { caller: VerifiedCaller; paymentId: string }): Promise<Payment> {
    const payment = await paymentStore.get(input.paymentId);
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found');
    if (
      payment.payerUserId !== input.caller.userId &&
      payment.collectorUserId !== input.caller.userId
    ) {
      throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found');
    }
    return payment;
  },
};

function replaceParticipant(participants: Participant[], updated: Participant): Participant[] {
  return participants.map((p) => (p.userId === updated.userId ? updated : p));
}

/**
 * What the guest owes for their claims right now. After lock-claims
 * (`paying`) it's the locked `owedPence`; otherwise their current claims
 * and splits plus their share of service and tax.
 */
/**
 * #216: guests pay once every line is claimed, or once the lead lets them
 * pay early. A locked or closed bill is open. The lead's bank details only
 * reach a guest's phone in the link's `#p=` (ADR-0002), so hiding them until
 * then is the web app's job; this stops the payment itself.
 */
function assertPaymentsOpen(session: Session): void {
  // #216: the lead opens payments (POST open-payments); every line being
  // claimed doesn't by itself. A locked or closed bill is open.
  if (paymentsAreOpen(session)) return;
  throw new AppError('PAYMENTS_NOT_OPEN', 'The lead hasn’t opened payments yet');
}

async function owedNow(session: Session, participant: Participant): Promise<number> {
  if (
    session.status === 'paying' &&
    typeof participant.owedPence === 'number' &&
    participant.owedPence > 0
  ) {
    return participant.owedPence;
  }
  const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
  if (!bill) throw new AppError('SESSION_INVALID_STATE', 'Bill not found for owed-amount calc');
  return computeOwedForParticipant(bill, session, participant);
}

/**
 * Everyone paying does NOT settle the session any more. Only the lead's
 * `POST /v1/sessions/:id/close` does: a bill can look complete while an
 * item is still unclaimed or a split still has a seat open, and someone
 * may yet join to take it. We just log the milestone.
 */
function maybeSettleSession(session: Session, logger?: Logger): void {
  if (session.status !== 'paying' && session.status !== 'claiming') return;
  const nonSelfPaid = session.participants.filter((p) => p.payment.status !== 'self_paid');
  if (nonSelfPaid.every((p) => p.payment.status === 'succeeded')) {
    logger?.info(
      { sessionId: session.sessionId },
      'everyone has paid; waiting for the lead to close',
    );
  }
}

function buildManualInstructions(args: {
  payoutAccount: PayoutAccount | undefined;
  reference: string;
  amountPence: number;
}): PaymentInstructions {
  // monzo.me / revolut.me both take amount as decimal pounds in the path.
  //   Monzo:   https://monzo.me/<handle>/<amount>?d=<desc>&account_type=personal
  //   Revolut: https://revolut.me/<tag>/<amount>
  // We default account_type=personal because Monzo users with a Business
  // account on the same handle would otherwise see a disambiguation prompt.
  // The `d=` description shows in the payer's confirm screen + the lead's
  // feed. Revolut's public link format doesn't accept a description.
  const amountMajor = (args.amountPence / 100).toFixed(2);
  const links: { monzo?: string; revolut?: string } = {};
  if (args.payoutAccount?.monzoHandle) {
    const handle = encodeURIComponent(args.payoutAccount.monzoHandle);
    const desc = encodeURIComponent(args.reference);
    links.monzo = `https://monzo.me/${handle}/${amountMajor}?d=${desc}&account_type=personal`;
  }
  if (args.payoutAccount?.revolutTag) {
    const tag = encodeURIComponent(args.payoutAccount.revolutTag);
    links.revolut = `https://revolut.me/${tag}/${amountMajor}`;
  }
  return {
    type: 'manual_transfer',
    ...(args.payoutAccount && {
      bankDetails: {
        sortCode: args.payoutAccount.sortCode,
        accountNumber: args.payoutAccount.accountNumber,
        accountHolderName: args.payoutAccount.accountHolderName,
      },
    }),
    reference: args.reference,
    amountPence: args.amountPence,
    links,
  };
}
