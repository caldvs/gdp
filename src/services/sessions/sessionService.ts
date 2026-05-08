import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { billStore } from '../../storage/billStore.js';
import { generateJoinCode } from './joinCode.js';
import { computeOwed } from './allocation.js';
import type { Session, Participant, ClaimsRequest } from '../../types/sessions.js';

export interface VerifiedCaller {
  userId: string;
  displayName: string;
}

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

    let lastErr: unknown;
    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt += 1) {
      try {
        await sessionStore.create(session);
        return projectForCaller(session, input.caller.userId);
      } catch (err) {
        lastErr = err;
        if (isConditionalCheckFailed(err)) {
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

    await sessionStore.putParticipant(session.sessionId, updatedCreator);
    await sessionStore.putMeta(updatedMeta);

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

    const allowed = (session.status === 'setup' && isCreator) || session.status === 'claiming';
    if (!allowed) {
      throw new AppError('SESSION_INVALID_STATE', 'Claims cannot be modified in this state');
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
    const updated: Participant = { ...target, claimedItemIds: dedupedClaims };
    await sessionStore.putParticipant(session.sessionId, updated);

    return projectForCaller(
      {
        ...session,
        participants: session.participants.map((p) => (p.userId === updated.userId ? updated : p)),
      },
      input.caller.userId,
    );
  },

  async lockClaims(input: { caller: VerifiedCaller; sessionId: string }): Promise<Session> {
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
    if (session.status === 'paying') {
      await sessionStore.deleteBillLock(session.billId).catch(() => undefined);
    }

    return projectForCaller(
      { ...updatedMeta, participants: session.participants },
      input.caller.userId,
    );
  },
};

/**
 * Hide the join code from non-creator callers in `setup`.
 */
function projectForCaller(session: Session, callerUserId: string): Session {
  if (session.status === 'setup' && session.creatorUserId !== callerUserId) {
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
