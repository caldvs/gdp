/** A table's life: created, shared, locked, closed or binned; and the fee it owes at settle. */
import { uuidv7 } from '../../lib/uuid.js';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { billStore } from '../../storage/billStore.js';
import { isConditionalCheckFailed, retryOnConflict } from '../../storage/conflict.js';
import { entitlementOps } from '../../storage/tableFeeStore.js';
import type { ShareEntitlement } from '../billing/tableFee.js';
import { generateJoinCode } from './joinCode.js';
import { computeOwed } from './allocation.js';
import { feeFor, isSent, paymentsOf, roundUpPence } from '../payments/ledger.js';
import type { VerifiedCaller } from '../../context/caller.js';
import { type Session, type Participant } from '../../types/sessions.js';
import { busy } from './sessionInternal.js';
import { projectForCaller } from './sessionView.js';

const CODE_COLLISION_RETRIES = 3;

export const lifecycleMethods = {
  async create(input: {
    caller: VerifiedCaller;
    billId: string;
    billVersion?: number;
    expectedDiners?: number;
  }): Promise<Session> {
    const bill =
      input.billVersion !== undefined
        ? await billStore.getVersion(input.billId, input.billVersion)
        : await billStore.getLatest(input.billId);
    if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');
    if (bill.creatorUserId !== input.caller.userId) {
      throw new AppError('BILL_NOT_FOUND', 'Bill not found');
    }

    const sessionId = uuidv7();
    const creatorParticipant: Participant = {
      userId: input.caller.userId,
      displayName: input.caller.displayName,
      ...(input.caller.avatarUrl ? { avatarUrl: input.caller.avatarUrl } : {}),
      claimedItemIds: [],
      sharedItemIds: [],
      payment: { status: 'unpaid' },
      // Creator's "ready" doesn't gate lock-claims — they ARE the locker.
      // Mark them ready by default so the all-ready check is just about guests.
      readyToLock: true,
    };
    const session: Session = {
      sessionId,
      status: 'setup',
      creatorUserId: input.caller.userId,
      collectorUserId: input.caller.userId,
      billId: bill.billId,
      pinnedBillVersion: bill.versionNumber,
      joinCode: generateJoinCode(),
      participants: [creatorParticipant],
      ...(bill.venue ? { venue: bill.venue } : {}),
      ...(input.expectedDiners !== undefined ? { expectedDiners: input.expectedDiners } : {}),
      createdAt: new Date().toISOString(),
    };

    // Check if the bill is already locked into another session before
    // attempting create — this surfaces a clean error rather than a generic
    // ConditionalCheckFailed. There's a small race window if two creates
    // run concurrently for the same bill; the conditional Put on the
    // bill-lock row inside `sessionStore.create` is the authoritative gate.
    const existingLock = await sessionStore.getBillLock(bill.billId);
    if (existingLock) {
      throw new AppError('SESSION_INVALID_STATE', 'Bill is already in use by another session', {
        sessionId: existingLock.sessionId,
      });
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt += 1) {
      try {
        await sessionStore.create(session);
        return projectForCaller(session, input.caller.userId);
      } catch (err) {
        lastErr = err;
        if (isConditionalCheckFailed(err)) {
          // Could be the join-code or the bill-lock conditional. Re-check
          // the bill lock; if it now exists, the race has resolved against us.
          const lockNow = await sessionStore.getBillLock(bill.billId);
          if (lockNow) {
            throw new AppError(
              'SESSION_INVALID_STATE',
              'Bill is already in use by another session',
              { sessionId: lockNow.sessionId },
            );
          }
          session.joinCode = generateJoinCode();
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('session create failed');
  },

  async share(input: {
    caller: VerifiedCaller;
    sessionId: string;
    /**
     * What pays for the share (the bill's fee, an exempt lead, or this
     * month's credit), or throws TABLE_FEE_REQUIRED. Absent when Stripe is
     * off: sharing is free.
     */
    entitle?: (session: Session) => Promise<ShareEntitlement>;
  }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    if (session.creatorUserId !== input.caller.userId) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    if (session.status !== 'setup') {
      throw new AppError('SESSION_INVALID_STATE', 'Session is not in setup');
    }

    // Per ADR-0002 we no longer gate /share on server-side payout details.
    // Bank details are device-local and reach guests via the join QR; the
    // server has no business reading or requiring them here.

    const creator = session.participants.find((p) => p.userId === session.creatorUserId);
    if (!creator) throw new Error('Invariant: creator missing from participants');

    const updatedCreator: Participant = { ...creator, payment: { status: 'self_paid' } };
    const entitlement = input.entitle ? await input.entitle(session) : null;
    const { participants: _, ...meta } = session;
    const updatedMeta: Omit<Session, 'participants'> = {
      ...meta,
      status: 'claiming',
      // A hold is paid back by the guests (#166); a credit costs them nothing.
      ...(entitlement?.kind === 'fee' && entitlement.holdPence
        ? { platformFeePence: entitlement.holdPence }
        : {}),
    };
    try {
      await sessionStore.applyShare({
        sessionMeta: updatedMeta,
        creator: updatedCreator,
        entitlement: entitlement ? entitlementOps(entitlement) : [],
      });
    } catch (err) {
      // The fee was spent or refunded, or the credit claimed, in between.
      if (entitlement && isConditionalCheckFailed(err)) {
        throw new AppError('TABLE_FEE_REQUIRED', 'Pay the platform fee to share this bill');
      }
      throw err;
    }

    return projectForCaller(
      {
        ...updatedMeta,
        participants: session.participants.map((p) =>
          p.userId === updatedCreator.userId ? updatedCreator : p,
        ),
      },
      input.caller.userId,
    );
  },

  /**
   * The platform fee at settle (4 Nov 2026; #228, 8 Nov): the round-ups of
   * the guests whose payment the lead confirmed. When guests say they've
   * paid but the lead confirmed none, the round-ups of those who say they
   * have, so never confirming isn't a way out of it. A hold from before #228
   * caps it at the hold; the saved card is charged it in full. Reads the
   * stored session (with each split's ways) and the pinned bill. 0 when no
   * hold paid for it.
   */
  async guestsFeePence(sessionId: string): Promise<number> {
    const session = await sessionStore.get(sessionId);
    if (!session?.platformFeePence) return 0;
    const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
    if (!bill) return 0;
    const guests = session.participants.filter((p) => p.userId !== session.creatorUserId);
    const confirmed = guests.filter((p) => paymentsOf(p, 0).some((e) => e.status === 'succeeded'));
    if (confirmed.length === 0) {
      const sent = guests.filter((p) => paymentsOf(p, 0).some(isSent));
      return sent.reduce((acc, p) => acc + feeFor(bill, session, p), 0);
    }
    return confirmed.reduce((acc, p) => acc + feeFor(bill, session, p), 0);
  },

  /**
   * #216: payments open by themselves once every line is claimed; this is
   * the lead opening them early. Amounts don't change; what's still
   * unclaimed is the lead's at settle. Lead only, while the bill is live.
   * Idempotent.
   */
  async openPayments(input: { caller: VerifiedCaller; sessionId: string }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session || session.creatorUserId !== input.caller.userId) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    if (session.status !== 'claiming' && session.status !== 'paying') {
      throw new AppError('SESSION_INVALID_STATE', `Session is ${session.status}`);
    }
    const at = session.paymentsOpenedAt ?? new Date().toISOString();
    if (!session.paymentsOpenedAt) await sessionStore.setPaymentsOpened(session.sessionId, at);
    return projectForCaller({ ...session, paymentsOpenedAt: at }, input.caller.userId);
  },

  async lockClaims(input: {
    caller: VerifiedCaller;
    sessionId: string;
    force?: boolean;
  }): Promise<Session> {
    // A guest claiming, readying or paying while the lead locks changes
    // their row; the lock then re-reads and works out owed amounts again.
    return retryOnConflict(async () => {
      const session = await sessionStore.get(input.sessionId);
      if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
      if (session.creatorUserId !== input.caller.userId) {
        throw new AppError('SESSION_NOT_FOUND', 'Session not found');
      }
      if (session.status !== 'claiming') {
        throw new AppError('SESSION_INVALID_STATE', 'Session is not in claiming');
      }

      const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
      if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');

      // Check claims completeness before readiness — a missing claim is more
      // actionable than a missing ready signal ("get N to claim X" vs "ask N
      // to mark themselves done").
      let owed: Map<string, number>;
      try {
        owed = computeOwed(
          bill,
          session.participants,
          new Map((session.shareSettings ?? []).map((st) => [st.itemId, st.ways])),
          new Map((session.shareSettings ?? []).map((st) => [st.itemId, st.units ?? 1])),
          session.creatorUserId,
        );
      } catch (err) {
        if (err instanceof Error && err.message === 'CLAIMS_INCOMPLETE') {
          throw new AppError(
            'CLAIMS_INCOMPLETE',
            'All bill items (and every spot in a split) must be claimed',
            { unclaimedItemIds: (err as Error & { unclaimedItemIds: string[] }).unclaimedItemIds },
          );
        }
        throw err;
      }

      // Hybrid claim model: all non-creator participants must signal ready
      // before the lead can lock, unless they pass force=true. This stops the
      // lead from racing ahead of a slower diner who's still toggling items.
      if (!input.force) {
        const notReady = session.participants
          .filter((p) => p.userId !== session.creatorUserId && !p.readyToLock)
          .map((p) => p.userId);
        if (notReady.length > 0) {
          throw new AppError(
            'PARTICIPANTS_NOT_READY',
            'One or more participants have not yet marked themselves ready',
            { notReadyUserIds: notReady },
          );
        }
      }

      const updatedParticipants: Participant[] = session.participants.map((p) => ({
        ...p,
        // Plus their round-up to the next whole pound.
        owedPence:
          (owed.get(p.userId) ?? 0) +
          (p.userId === session.creatorUserId
            ? 0
            : roundUpPence(session.platformFeePence ?? 0, owed.get(p.userId) ?? 0)),
      }));
      const { participants: _, ...meta } = session;
      const updatedMeta: Omit<Session, 'participants'> = { ...meta, status: 'paying' };

      await sessionStore.applyLockClaims({
        sessionMeta: updatedMeta,
        participants: updatedParticipants,
      });

      return projectForCaller(
        { ...updatedMeta, participants: updatedParticipants },
        input.caller.userId,
      );
    }, busy);
  },

  /**
   * The lead closes the bill: "I've stopped waiting at the table." The
   * session becomes `settled` whatever's still unpaid or unclaimed
   * (unclaimed items are the lead's by implication). Guests who still
   * owe can pay afterwards; paymentService accepts payments on a
   * settled session for a participant who hasn't paid.
   */
  async close(input: {
    caller: VerifiedCaller;
    sessionId: string;
    /** Runs once, when this call is the one that settles the bill. */
    onClosed?: (sessionId: string) => Promise<void>;
  }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    if (session.creatorUserId !== input.caller.userId) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    if (session.status === 'settled') {
      return projectForCaller(session, input.caller.userId);
    }
    if (session.status !== 'claiming' && session.status !== 'paying') {
      throw new AppError('SESSION_INVALID_STATE', `Session is ${session.status}; can't close`);
    }
    const { participants: _, ...meta } = session;
    const updatedMeta: Omit<Session, 'participants'> = { ...meta, status: 'settled' };
    await sessionStore.putMeta(updatedMeta);
    // A closed bill is done with: release it so the lead can amend it or
    // share it again. Guests keep reading it through their sessions.
    await sessionStore.deleteBillLock(session.billId).catch(() => undefined);
    await input.onClosed?.(session.sessionId);
    return projectForCaller(
      { ...updatedMeta, participants: session.participants },
      input.caller.userId,
    );
  },

  async abandon(input: { caller: VerifiedCaller; sessionId: string }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    if (session.creatorUserId !== input.caller.userId) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    if (session.status === 'settled') {
      throw new AppError('SESSION_INVALID_STATE', 'Settled sessions cannot be abandoned');
    }

    const { participants: _, ...meta } = session;
    const updatedMeta: Omit<Session, 'participants'> = { ...meta, status: 'abandoned' };
    await sessionStore.putMeta(updatedMeta);
    // Bill is locked from session-create through any non-settled state.
    // Abandon releases the lock so the creator can amend the bill or
    // start a fresh session.
    await sessionStore.deleteBillLock(session.billId).catch(() => undefined);

    return projectForCaller(
      { ...updatedMeta, participants: session.participants },
      input.caller.userId,
    );
  },
};
