import { v7 as uuidv7 } from 'uuid';
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
    // Setup / settled / abandoned remain hard-rejected.
    if (session.status !== 'paying' && session.status !== 'claiming') {
      throw new AppError(
        'SESSION_INVALID_STATE',
        `Session is ${session.status}; can't pay`,
      );
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
    // If the lead hasn't locked claims yet, `owedPence` won't be set on
    // the participant. Compute on the fly from their current claims +
    // their share of extras (service + tax, apportioned by subtotal).
    // Mirrors the indicative running total the frontend already shows.
    let computedOwed: number | undefined;
    if (typeof participant.owedPence !== 'number' || participant.owedPence <= 0) {
      const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
      if (!bill) {
        throw new AppError('SESSION_INVALID_STATE', 'Bill not found for owed-amount calc');
      }
      computedOwed = computeOwedForParticipant(bill, session, participant);
      if (computedOwed <= 0) {
        throw new AppError('SESSION_INVALID_STATE', 'Nothing claimed yet');
      }
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
    const reference = `gdp-${session.sessionId.slice(0, 8)}`;
    const amountPence = computedOwed ?? participant.owedPence!;

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
        beneficiary: collector.payoutAccount,
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
        payoutAccount: collector.payoutAccount,
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

    const updatedParticipant: Participant = {
      ...participant,
      payment: { status: 'pending', paymentId },
    };

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
      await paymentStore.setParticipantPayerClaimedPaidAt({
        sessionId: payment.sessionId,
        userId: payment.payerUserId,
        ts: updated.payerClaimedPaidAt,
      });
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
    const updatedParticipant: Participant = {
      ...participant,
      payment: { status: 'succeeded', paymentId: payment.paymentId, paidAt: now },
    };
    await paymentStore.applyUpdate({ payment: updatedPayment, participant: updatedParticipant });

    await maybeSettleSession(
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
function computeOwedForParticipant(
  bill: { items: ReadonlyArray<{ itemId: string; unitPricePence: number }>; subtotalPence: number; serviceChargePence: number; taxPence: number },
  session: Session,
  participant: Participant,
): number {
  let claimSub = 0;
  for (const id of participant.claimedItemIds) {
    const item = bill.items.find((it) => it.itemId === id);
    if (item) claimSub += item.unitPricePence;
  }
  // Share subtotal (ADR-0006): equal split, remainder pennies go to
  // the lowest-userId sharer.
  let shareSub = 0;
  for (const itemId of participant.sharedItemIds ?? []) {
    const item = bill.items.find((it) => it.itemId === itemId);
    if (!item) continue;
    const sharers = session.participants
      .filter((p) => (p.sharedItemIds ?? []).includes(itemId))
      .map((p) => p.userId);
    if (sharers.length === 0) continue;
    const base = Math.floor(item.unitPricePence / sharers.length);
    const remainder = item.unitPricePence - base * sharers.length;
    const lowestUserId = [...sharers].sort()[0];
    shareSub += base + (participant.userId === lowestUserId ? remainder : 0);
  }
  const extras = bill.serviceChargePence + bill.taxPence;
  const extrasRate = bill.subtotalPence > 0 ? extras / bill.subtotalPence : 0;
  return Math.round((claimSub + shareSub) * (1 + extrasRate));
}

async function maybeSettleSession(session: Session, logger?: Logger): Promise<void> {
  // Trust-based shift: settlement can happen straight from `claiming`
  // (when guests have paid without the lead ever calling lock-claims)
  // or from the legacy `paying` state. Setup / settled / abandoned
  // never auto-settle.
  if (session.status !== 'paying' && session.status !== 'claiming') return;
  const nonSelfPaid = session.participants.filter((p) => p.payment.status !== 'self_paid');
  const allSucceeded = nonSelfPaid.every((p) => p.payment.status === 'succeeded');
  if (!allSucceeded) return;

  const { participants: _participants, ...meta } = session;
  await sessionStore.putMeta({ ...meta, status: 'settled' });
  logger?.info({ sessionId: session.sessionId }, 'session settled');
}

function buildManualInstructions(args: {
  payoutAccount: PayoutAccount;
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
  if (args.payoutAccount.monzoHandle) {
    const handle = encodeURIComponent(args.payoutAccount.monzoHandle);
    const desc = encodeURIComponent(args.reference);
    links.monzo = `https://monzo.me/${handle}/${amountMajor}?d=${desc}&account_type=personal`;
  }
  if (args.payoutAccount.revolutTag) {
    const tag = encodeURIComponent(args.payoutAccount.revolutTag);
    links.revolut = `https://revolut.me/${tag}/${amountMajor}`;
  }
  return {
    type: 'manual_transfer',
    bankDetails: {
      sortCode: args.payoutAccount.sortCode,
      accountNumber: args.payoutAccount.accountNumber,
      accountHolderName: args.payoutAccount.accountHolderName,
    },
    reference: args.reference,
    amountPence: args.amountPence,
    links,
  };
}
