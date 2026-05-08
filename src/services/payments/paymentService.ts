import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { paymentStore } from '../../storage/paymentStore.js';
import { userStore } from '../../storage/userStore.js';
import { isAlreadyApplied, nextStatus } from './stateMachine.js';
import type { Logger } from '../../logging/logger.js';
import type { VerifiedCaller } from '../../context/caller.js';
import type { Participant, Session } from '../../types/sessions.js';
import type { Payment, PaymentEvent } from '../../types/payments.js';
import type { PaymentProvider, WebhookEvent } from './provider.js';

export const paymentService = {
  async initiate(input: {
    caller: VerifiedCaller;
    sessionId: string;
    idempotencyKey: string;
    provider: PaymentProvider;
    logger?: Logger;
  }): Promise<{ payment: Payment; providerRedirectUrl: string }> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    const participant = session.participants.find((p) => p.userId === input.caller.userId);
    if (!participant) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    if (session.status !== 'paying') {
      throw new AppError('SESSION_INVALID_STATE', 'Session is not paying');
    }
    if (participant.payment.status !== 'unpaid' && participant.payment.status !== 'failed') {
      throw new AppError(
        'SESSION_INVALID_STATE',
        'Participant payment is already in flight or settled',
      );
    }
    if (participant.userId === session.collectorUserId) {
      throw new AppError('SESSION_INVALID_STATE', 'Collector does not pay themselves');
    }
    if (typeof participant.owedPence !== 'number' || participant.owedPence <= 0) {
      throw new AppError('SESSION_INVALID_STATE', 'Participant has nothing owed');
    }

    // Beneficiary = the collector's saved bank details. The /share gate
    // means a session can't reach `paying` without these set, so this
    // load should always succeed; the explicit error preserves a clean
    // failure mode if data has been deleted out from under us.
    const collector = await userStore.get(session.collectorUserId);
    if (!collector?.payoutAccount) {
      throw new AppError('PAYOUT_ACCOUNT_REQUIRED', 'Collector has no payout account on file');
    }

    const paymentId = uuidv7();
    const initiated = await initiateOrTranslate(input.provider, {
      paymentId,
      amountPence: participant.owedPence,
      currency: 'GBP',
      payerUserId: participant.userId,
      collectorUserId: session.collectorUserId,
      reference: `gdp-${session.sessionId.slice(0, 8)}`,
      beneficiary: collector.payoutAccount,
    });

    const now = new Date().toISOString();
    const payment: Payment = {
      paymentId,
      sessionId: session.sessionId,
      payerUserId: participant.userId,
      collectorUserId: session.collectorUserId,
      amountPence: participant.owedPence,
      currency: 'GBP',
      provider: input.provider.name,
      providerPaymentId: initiated.providerPaymentId,
      status: 'pending',
      idempotencyKey: input.idempotencyKey,
      events: [{ at: now, from: 'pending', to: 'pending', source: 'system', note: 'created' }],
      createdAt: now,
    };

    const updatedParticipant: Participant = {
      ...participant,
      payment: { status: 'pending', paymentId },
    };

    await paymentStore.applyUpdate({ payment, participant: updatedParticipant });

    return { payment, providerRedirectUrl: initiated.authorizationUrl };
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

    const updatedParticipant: Participant = {
      ...participant,
      payment: paymentStateForParticipant(payment.paymentId, next, now, input.event.reason),
    };

    await paymentStore.applyUpdate({
      payment: updatedPayment,
      participant: updatedParticipant,
    });

    if (next === 'succeeded') {
      await maybeSettleSession(
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

function paymentStateForParticipant(
  paymentId: string,
  status: 'authorized' | 'succeeded' | 'failed' | 'refunded' | 'pending',
  now: string,
  reason: string | undefined,
): Participant['payment'] {
  switch (status) {
    case 'pending':
    case 'authorized':
      return { status: 'pending', paymentId };
    case 'succeeded':
      return { status: 'succeeded', paymentId, paidAt: now };
    case 'failed':
      return { status: 'failed', paymentId, reason: reason ?? 'failed' };
    case 'refunded':
      return { status: 'unpaid' };
  }
}

function replaceParticipant(participants: Participant[], updated: Participant): Participant[] {
  return participants.map((p) => (p.userId === updated.userId ? updated : p));
}

async function maybeSettleSession(session: Session, logger?: Logger): Promise<void> {
  if (session.status !== 'paying') return;
  const nonSelfPaid = session.participants.filter((p) => p.payment.status !== 'self_paid');
  const allSucceeded = nonSelfPaid.every((p) => p.payment.status === 'succeeded');
  if (!allSucceeded) return;

  const { participants: _participants, ...meta } = session;
  await sessionStore.putMeta({ ...meta, status: 'settled' });
  logger?.info({ sessionId: session.sessionId }, 'session settled');
}
