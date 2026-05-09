import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { billStore } from '../../storage/billStore.js';
import { generateJoinCode } from './joinCode.js';
import { computeOwed } from './allocation.js';
import type { VerifiedCaller } from '../../context/caller.js';
import type { Session, Participant, ClaimsRequest } from '../../types/sessions.js';

export type { VerifiedCaller };

const CODE_COLLISION_RETRIES = 3;

export const sessionService = {
  async create(input: {
    caller: VerifiedCaller;
    billId: string;
    billVersion?: number;
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
      claimedItemIds: [],
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

  async get(input: { caller: VerifiedCaller; sessionId: string }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    const isParticipant = session.participants.some((p) => p.userId === input.caller.userId);
    if (!isParticipant) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    return projectForCaller(session, input.caller.userId);
  },

  async resolveByCode(input: { code: string }): Promise<{ sessionId: string }> {
    const resolved = await sessionStore.resolveJoinCode(input.code);
    if (!resolved) throw new AppError('NOT_FOUND', 'Code not found');
    const session = await sessionStore.get(resolved.sessionId);
    if (!session) throw new AppError('NOT_FOUND', 'Session not found');
    if (session.status !== 'claiming') {
      throw new AppError('NOT_FOUND', 'Code not active');
    }
    return { sessionId: resolved.sessionId };
  },

  async share(input: { caller: VerifiedCaller; sessionId: string }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    if (session.creatorUserId !== input.caller.userId) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    if (session.status !== 'setup') {
      throw new AppError('SESSION_INVALID_STATE', 'Session is not in setup');
    }

    const creator = session.participants.find((p) => p.userId === session.creatorUserId);
    if (!creator) throw new Error('Invariant: creator missing from participants');

    const updatedCreator: Participant = { ...creator, payment: { status: 'self_paid' } };
    const { participants: _, ...meta } = session;
    const updatedMeta: Omit<Session, 'participants'> = { ...meta, status: 'claiming' };

    await sessionStore.applyShare({ sessionMeta: updatedMeta, creator: updatedCreator });

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

  async join(input: { caller: VerifiedCaller; sessionId: string }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    if (session.status !== 'claiming') {
      throw new AppError('SESSION_INVALID_STATE', 'Session is not accepting joins');
    }
    if (session.participants.some((p) => p.userId === input.caller.userId)) {
      return projectForCaller(session, input.caller.userId);
    }

    const newParticipant: Participant = {
      userId: input.caller.userId,
      displayName: input.caller.displayName,
      claimedItemIds: [],
      payment: { status: 'unpaid' },
      readyToLock: false,
    };
    await sessionStore.putParticipant(session.sessionId, newParticipant);

    return projectForCaller(
      { ...session, participants: [...session.participants, newParticipant] },
      input.caller.userId,
    );
  },

  async setClaims(input: {
    caller: VerifiedCaller;
    sessionId: string;
    claims: ClaimsRequest;
  }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');

    const isCreator = session.creatorUserId === input.caller.userId;
    const isParticipant = session.participants.some((p) => p.userId === input.caller.userId);
    if (!isParticipant) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }

    // Creator claims their items in setup; others claim in claiming.
    // Once shared, the creator's claims are frozen.
    const allowed =
      (session.status === 'setup' && isCreator) || (session.status === 'claiming' && !isCreator);
    if (!allowed) {
      throw new AppError(
        'SESSION_INVALID_STATE',
        isCreator
          ? 'Creator claims are frozen once the session has been shared'
          : 'Claims cannot be modified in this state',
      );
    }

    const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
    if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');
    const validItemIds = new Set(bill.items.map((it) => it.itemId));
    const dedupedClaims = [...new Set(input.claims.claimedItemIds)];
    for (const id of dedupedClaims) {
      if (!validItemIds.has(id)) {
        throw new AppError('INVALID_INPUT', 'Unknown itemId in claim list', { itemId: id });
      }
    }

    const target = session.participants.find((p) => p.userId === input.caller.userId);
    if (!target) throw new Error('Invariant: caller participant missing');
    // Editing claims un-readies the participant — "I'm done" should mean
    // "I'm done with my CURRENT claims". Creator stays implicitly ready.
    const updated: Participant = {
      ...target,
      claimedItemIds: dedupedClaims,
      readyToLock: isCreator ? target.readyToLock : false,
    };
    await sessionStore.putParticipant(session.sessionId, updated);

    return projectForCaller(
      {
        ...session,
        participants: session.participants.map((p) => (p.userId === updated.userId ? updated : p)),
      },
      input.caller.userId,
    );
  },

  async setReady(input: {
    caller: VerifiedCaller;
    sessionId: string;
    ready: boolean;
  }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    if (session.status !== 'claiming') {
      throw new AppError('SESSION_INVALID_STATE', 'Session is not in claiming');
    }
    const target = session.participants.find((p) => p.userId === input.caller.userId);
    if (!target) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    // Creator's ready flag is always true; reject explicit toggles to avoid
    // surprise behaviour (use lock-claims directly).
    if (target.userId === session.creatorUserId) {
      throw new AppError('SESSION_INVALID_STATE', 'Creator does not signal ready; use lock-claims');
    }

    const updated: Participant = { ...target, readyToLock: input.ready };
    await sessionStore.putParticipant(session.sessionId, updated);
    return projectForCaller(
      {
        ...session,
        participants: session.participants.map((p) => (p.userId === updated.userId ? updated : p)),
      },
      input.caller.userId,
    );
  },

  async lockClaims(input: {
    caller: VerifiedCaller;
    sessionId: string;
    force?: boolean;
  }): Promise<Session> {
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
      owed = computeOwed(bill, session.participants);
    } catch (err) {
      if (err instanceof Error && err.message === 'CLAIMS_INCOMPLETE') {
        throw new AppError(
          'CLAIMS_INCOMPLETE',
          'All bill items must be claimed by at least one participant',
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
      owedPence: owed.get(p.userId) ?? 0,
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

/**
 * Project the session for the caller. The join code is hidden from everyone
 * (including the creator) while the session is in `setup`; it becomes visible
 * once `share` activates the code.
 */
function projectForCaller(session: Session, _callerUserId: string): Session {
  if (session.status === 'setup') {
    const { joinCode: _hidden, ...rest } = session;
    return rest;
  }
  return session;
}

function isConditionalCheckFailed(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (e.name === 'ConditionalCheckFailedException') return true;
  if (e.name === 'TransactionCanceledException') {
    return Boolean(e.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed'));
  }
  return false;
}
