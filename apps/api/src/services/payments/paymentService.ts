import { v7 as uuidv7 } from 'uuid';
import {
  aggregatePayment,
  computeOwedForParticipant,
  draftOf,
  paymentsOf,
  sentPence,
  withPayment,
} from './ledger.js';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { paymentStore } from '../../storage/paymentStore.js';
import { userStore } from '../../storage/userStore.js';
import { billStore } from '../../storage/billStore.js';
import { isAlreadyApplied, nextStatus } from './stateMachine.js';
import type { Logger } from '../../logging/logger.js';
import type { VerifiedCaller } from '../../context/caller.js';
import type { Participant, Session } from '../../types/sessions.js';
import type { Payment, PaymentEvent, PaymentInstructions } from '../../types/payments.js';
import type { PayoutAccount } from '../../types/users.js';
import type { PaymentProvider, WebhookEvent } from './provider.js';

export const paymentService = {
  async initiate(input: {
    caller: VerifiedCaller;
    sessionId: string;
    idempotencyKey: string;
    /** null = manual mode (guest pays via their own banking app, lead confirms). */
    provider: PaymentProvider | null;
    logger?: Logger;
  }): Promise<{ payment: Payment; instructions: PaymentInstructions }> {
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
    // for the right amount (manual: same reference and details), else
    // close it and open one for the new amount.
    const draft = draftOf(entries);
    if (draft) {
      const old = await paymentStore.get(draft.paymentId);
      if (
        old &&
        old.status === 'pending' &&
        old.amountPence === duePence &&
        old.provider === 'manual' &&
        !input.provider
      ) {
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

    // Beneficiary = the collector's saved bank details. Per ADR-0002 the
    // lead's bank details normally live on their device and reach guests
    // inside the join QR, so in manual mode they're optional here: if we
    // have them we echo them back (plus Monzo/Revolut links), otherwise
    // the client shows the details it got from the QR. A real provider
    // (TrueLayer) needs a beneficiary, so it still requires them.
    const collector = await userStore.get(session.collectorUserId);
    if (input.provider && !collector?.payoutAccount) {
      throw new AppError('PAYOUT_ACCOUNT_REQUIRED', 'Collector has no payout account on file');
    }

    const paymentId = uuidv7();
    const reference = `gdp-${session.sessionId.slice(0, 8)}`;
    const amountPence = duePence;

    let providerPaymentId: string;
    let providerName: 'truelayer' | 'manual';
    let instructions: PaymentInstructions;

    if (input.provider) {
      const initiated = await initiateOrTranslate(input.provider, {
        paymentId,
        amountPence,
        currency: 'GBP',
        payerUserId: participant.userId,
        collectorUserId: session.collectorUserId,
        reference,
        beneficiary: collector!.payoutAccount!,
      });
      providerPaymentId = initiated.providerPaymentId;
      providerName = input.provider.name;
      instructions = { type: 'redirect', url: initiated.authorizationUrl };
    } else {
      // Manual mode: no external provider call. The "providerPaymentId" is
      // synthetic — it just satisfies the schema. Guest pays via their own
      // banking app; the lead drives the state transition via /confirm.
      providerPaymentId = `manual-${paymentId}`;
      providerName = 'manual';
      instructions = buildManualInstructions({
        payoutAccount: collector?.payoutAccount,
        reference,
        amountPence,
      });
    }

    const now = new Date().toISOString();
    const payment: Payment = {
      paymentId,
      sessionId: session.sessionId,
      payerUserId: participant.userId,
      collectorUserId: session.collectorUserId,
      amountPence,
      currency: 'GBP',
      provider: providerName,
      providerPaymentId,
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
  },

  /**
   * Payer claims they've sent the money via their bank app. Idempotent —
   * concurrent claims both end up with the same canonical timestamp (the
   * earlier write wins via DDB's `if_not_exists`). Doesn't advance state;
   * it's purely a UX signal so the lead knows which pending payments are
   * awaiting confirmation. Available for any provider, but really only
   * meaningful in manual mode (TL-mediated payments advance via webhook).
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
    }
    return updated;
  },

  /**
   * Manual mode only: collector marks a guest payment as received. Drives
   * the same DDB updates that a webhook would, plus runs session settlement.
   * Rejected for non-manual payments — those advance via webhook only.
   */
  async confirmManual(input: {
    caller: VerifiedCaller;
    paymentId: string;
    logger?: Logger;
  }): Promise<Payment> {
    const payment = await paymentStore.get(input.paymentId);
    if (!payment) throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found');
    if (payment.collectorUserId !== input.caller.userId) {
      throw new AppError('PAYMENT_NOT_FOUND', 'Payment not found');
    }
    if (payment.provider !== 'manual') {
      throw new AppError(
        'SESSION_INVALID_STATE',
        'Only manual payments can be confirmed by the collector; provider-mediated payments advance via webhook',
      );
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

  /**
   * Apply a verified webhook event to the payment + participant. Returns
   * the new payment status (or the unchanged one for replays / unknown
   * transitions). Settlement of the session itself is handled by
   * `maybeSettleSession` which runs after every successful payment.
   */
  async applyWebhookEvent(input: {
    event: WebhookEvent;
    logger?: Logger;
  }): Promise<{ status: 'applied' | 'noop' | 'invalid_transition' }> {
    const payment = await paymentStore.findByProviderPaymentId(input.event.providerPaymentId);
    if (!payment) {
      throw new AppError('PAYMENT_NOT_FOUND', 'Provider payment id is unknown');
    }

    if (isAlreadyApplied(payment.status, input.event.type)) {
      input.logger?.debug({ paymentId: payment.paymentId }, 'webhook replay');
      return { status: 'noop' };
    }

    const next = nextStatus(payment.status, input.event.type);
    if (!next) {
      input.logger?.warn(
        {
          paymentId: payment.paymentId,
          from: payment.status,
          eventType: input.event.type,
        },
        'invalid payment state transition',
      );
      return { status: 'invalid_transition' };
    }

    const session = await sessionStore.get(payment.sessionId);
    if (!session) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    const participant = session.participants.find((p) => p.userId === payment.payerUserId);
    if (!participant) {
      throw new AppError('SESSION_NOT_FOUND', 'Participant not found');
    }

    const now = new Date().toISOString();
    const event: PaymentEvent = {
      at: now,
      from: payment.status,
      to: next,
      source: 'webhook',
      note: input.event.reason ?? input.event.type,
    };

    const updatedPayment: Payment = {
      ...payment,
      status: next,
      events: [...payment.events, event],
    };

    const entries = paymentsOf(participant, payment.amountPence);
    const prev = entries.find((e) => e.paymentId === payment.paymentId) ?? {
      paymentId: payment.paymentId,
      amountPence: payment.amountPence,
    };
    // A refund takes the payment off the guest's list, so it's owed again.
    const remaining = entries.filter((e) => e.paymentId !== payment.paymentId);
    const updatedParticipant: Participant =
      next === 'refunded'
        ? { ...participant, payments: remaining, payment: aggregatePayment(remaining) }
        : withPayment(participant, entries, {
            ...prev,
            status: next === 'succeeded' ? 'succeeded' : next === 'failed' ? 'failed' : 'pending',
            ...(next === 'succeeded' ? { paidAt: now } : {}),
            ...(next === 'failed' ? { reason: input.event.reason ?? 'failed' } : {}),
          });

    await paymentStore.applyUpdate({
      payment: updatedPayment,
      participant: updatedParticipant,
    });

    if (next === 'succeeded') {
      maybeSettleSession(
        { ...session, participants: replaceParticipant(session.participants, updatedParticipant) },
        input.logger,
      );
    }

    return { status: 'applied' };
  },
};

async function initiateOrTranslate(
  provider: PaymentProvider,
  args: Parameters<PaymentProvider['initiate']>[0],
): Promise<Awaited<ReturnType<PaymentProvider['initiate']>>> {
  try {
    return await provider.initiate(args);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('PAYMENT_PROVIDER_ERROR', 'Payment provider error during initiate');
  }
}

function replaceParticipant(participants: Participant[], updated: Participant): Participant[] {
  return participants.map((p) => (p.userId === updated.userId ? updated : p));
}

/**
 * What the guest owes for their claims right now. After lock-claims
 * (`paying`) it's the locked `owedPence`; otherwise their current claims
 * and splits plus their share of service and tax.
 */
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
