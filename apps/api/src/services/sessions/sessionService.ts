import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { billStore } from '../../storage/billStore.js';
import { generateJoinCode } from './joinCode.js';
import { computeOwed } from './allocation.js';
import type { VerifiedCaller } from '../../context/caller.js';
import {
  SHARE_ACTIVITY_KEEP,
  SHARE_WAYS_MAX,
  type Session,
  type Participant,
  type ClaimsRequest,
  type ShareActivity,
  type ShareSettings,
} from '../../types/sessions.js';

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

    // Per ADR-0002 we no longer gate /share on server-side payout details.
    // Bank details are device-local and reach guests via the join QR; the
    // server has no business reading or requiring them here.

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
      ...(input.caller.avatarUrl ? { avatarUrl: input.caller.avatarUrl } : {}),
      claimedItemIds: [],
      sharedItemIds: [],
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

    // Creator can claim in setup (pre-share priming) or claiming (alongside
    // guests, in case they missed something). Guests can only claim in
    // claiming. Nobody claims in paying/settled/abandoned.
    const allowed = (session.status === 'setup' && isCreator) || session.status === 'claiming';
    if (!allowed) {
      throw new AppError('SESSION_INVALID_STATE', 'Claims cannot be modified in this state');
    }

    const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
    if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');

    // Per-unit semantics: claimedItemIds may contain the same itemId multiple
    // times — once per unit claimed. e.g. "I had 3 of the 6 Guinness" sends
    // the Guinness uuid three times. Validate each claim references a real
    // item, that the caller hasn't over-claimed beyond item.quantity, and
    // that the caller's claim plus claims from other participants doesn't
    // exceed item.quantity.
    const itemById = new Map(bill.items.map((it) => [it.itemId, it]));
    const claims = input.claims.claimedItemIds;
    const myCounts = new Map<string, number>();
    for (const id of claims) {
      const item = itemById.get(id);
      if (!item) {
        throw new AppError('INVALID_INPUT', 'Unknown itemId in claim list', { itemId: id });
      }
      myCounts.set(id, (myCounts.get(id) ?? 0) + 1);
    }
    for (const [id, count] of myCounts) {
      const item = itemById.get(id)!;
      if (count > item.quantity) {
        throw new AppError(
          'INVALID_INPUT',
          `You claimed ${count} of "${item.name}" but the bill only has ${item.quantity}`,
          { itemId: id, claimed: count, available: item.quantity },
        );
      }
      // Other-participants check: sum existing (excluding caller) + my new count must not exceed quantity
      const othersCount = session.participants
        .filter((p) => p.userId !== input.caller.userId)
        .reduce((acc, p) => acc + p.claimedItemIds.filter((c) => c === id).length, 0);
      if (othersCount + count > item.quantity) {
        throw new AppError(
          'SESSION_INVALID_STATE',
          `Only ${item.quantity - othersCount} of "${item.name}" left to claim`,
          { itemId: id, claimed: count, available: item.quantity - othersCount },
        );
      }
      // ADR-0006 v1: an item is in claim-mode or share-mode, not both.
      // If anyone (including the caller) currently shares this item we
      // refuse the claim — they must leave the share first via DELETE
      // /v1/sessions/:id/shares/:itemId.
      const isShared = session.participants.some((p) => p.sharedItemIds.includes(id));
      if (isShared) {
        throw new AppError(
          'CLAIM_SHARE_CONFLICT',
          `"${item.name}" is currently being shared; leave the share before claiming`,
          { itemId: id },
        );
      }
    }

    const target = session.participants.find((p) => p.userId === input.caller.userId);
    if (!target) throw new Error('Invariant: caller participant missing');
    // Editing claims un-readies the participant — "I'm done" should mean
    // "I'm done with my CURRENT claims". Creator stays implicitly ready.
    const updated: Participant = {
      ...target,
      claimedItemIds: claims,
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

  /**
   * Caller joins the splitter set for `itemId` (ADR-0006). Idempotent —
   * a no-op if already in the set. Returns the updated session.
   *
   * v1 simplification: item must have `quantity === 1` and must not be
   * in anyone's `claimedItemIds`. Either condition → 409.
   */
  async addShare(input: {
    caller: VerifiedCaller;
    sessionId: string;
    itemId: string;
    /** How many people shared it — only used when starting the split. */
    ways?: number;
  }): Promise<Session> {
    return withShareRetry(async () => {
      const session = await assertEditableSession(input.sessionId, input.caller.userId);
      const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
      if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');
      const item = bill.items.find((it) => it.itemId === input.itemId);
      if (!item) {
        throw new AppError('INVALID_INPUT', 'Unknown itemId', { itemId: input.itemId });
      }
      if (item.quantity !== 1) {
        throw new AppError(
          'ITEM_NOT_SHAREABLE',
          `"${item.name}" has quantity ${item.quantity}; only quantity-1 items are shareable in v1`,
          { itemId: input.itemId, quantity: item.quantity },
        );
      }
      const claimedByAnyone = session.participants.some((p) =>
        p.claimedItemIds.includes(input.itemId),
      );
      if (claimedByAnyone) {
        throw new AppError(
          'CLAIM_SHARE_CONFLICT',
          `"${item.name}" has been claimed; the claimer must release it before it can be shared`,
          { itemId: input.itemId },
        );
      }

      const target = session.participants.find((p) => p.userId === input.caller.userId);
      if (!target) throw new Error('Invariant: caller participant missing');
      if (target.sharedItemIds.includes(input.itemId)) {
        // Idempotent: already a sharer.
        return projectForCaller(session, input.caller.userId);
      }
      const isCreator = session.creatorUserId === input.caller.userId;
      const updated: Participant = {
        ...target,
        sharedItemIds: [...target.sharedItemIds, input.itemId],
        // Same logic as setClaims: editing my share set un-readies me.
        readyToLock: isCreator ? target.readyToLock : false,
      };

      const sharers = sharersOf(session, input.itemId);
      const existing = settingsOf(session, input.itemId);
      const at = new Date().toISOString();
      let settings: ShareSettings;
      if (sharers.length === 0) {
        // Starting the split: the starter says how many people shared it.
        const ways = input.ways ?? 2;
        settings = {
          itemId: input.itemId,
          ways,
          version: (existing?.version ?? 0) + 1,
          activity: [{ kind: 'started', byUserId: input.caller.userId, at, toWays: ways }],
        };
      } else {
        // Joining: take an open spot. If every spot is already taken, the
        // joiner is another person who shared it, so it becomes one more way.
        const current = existing?.ways ?? sharers.length;
        const full = sharers.length >= current;
        let ways = current;
        if (full) {
          if (anySharerPaid(session, sharers)) {
            throw new AppError(
              'SHARE_PAID',
              `Everyone in the "${item.name}" split has a spot and someone has already paid, so it can't be split more ways`,
              { itemId: input.itemId },
            );
          }
          ways = sharers.length + 1;
          if (ways > SHARE_WAYS_MAX) {
            throw new AppError(
              'INVALID_INPUT',
              `An item can be split at most ${SHARE_WAYS_MAX} ways`,
            );
          }
        }
        settings = {
          itemId: input.itemId,
          ways,
          version: (existing?.version ?? 0) + 1,
          activity: pushActivity(existing?.activity, {
            kind: 'joined',
            byUserId: input.caller.userId,
            at,
            ...(full && { fromWays: current, toWays: ways }),
          }),
        };
      }
      await sessionStore.applyShareChange({
        sessionId: session.sessionId,
        participant: updated,
        itemId: input.itemId,
        settings,
        expectedVersion: existing?.version ?? null,
      });
      return projectForCaller(
        withSettings(
          {
            ...session,
            participants: session.participants.map((p) =>
              p.userId === updated.userId ? updated : p,
            ),
          },
          settings,
        ),
        input.caller.userId,
      );
    });
  },

  /**
   * Caller leaves the splitter set for `itemId`. Idempotent — no-op if
   * not currently in the set. Returns the updated session.
   */
  async removeShare(input: {
    caller: VerifiedCaller;
    sessionId: string;
    itemId: string;
  }): Promise<Session> {
    return withShareRetry(async () => {
      const session = await assertEditableSession(input.sessionId, input.caller.userId);
      const target = session.participants.find((p) => p.userId === input.caller.userId);
      if (!target) throw new Error('Invariant: caller participant missing');
      if (!target.sharedItemIds.includes(input.itemId)) {
        return projectForCaller(session, input.caller.userId);
      }
      const isCreator = session.creatorUserId === input.caller.userId;
      const updated: Participant = {
        ...target,
        sharedItemIds: target.sharedItemIds.filter((id) => id !== input.itemId),
        readyToLock: isCreator ? target.readyToLock : false,
      };
      const sharers = sharersOf(session, input.itemId);
      const existing = settingsOf(session, input.itemId);
      // Leaving keeps the number of ways (the spot reopens). The last one
      // out removes the split altogether.
      const settings: ShareSettings | null =
        sharers.length <= 1
          ? null
          : {
              itemId: input.itemId,
              ways: existing?.ways ?? sharers.length,
              version: (existing?.version ?? 0) + 1,
              activity: pushActivity(existing?.activity, {
                kind: 'left',
                byUserId: input.caller.userId,
                at: new Date().toISOString(),
              }),
            };
      await sessionStore.applyShareChange({
        sessionId: session.sessionId,
        participant: updated,
        itemId: input.itemId,
        settings,
        expectedVersion: existing?.version ?? null,
      });
      return projectForCaller(
        withSettings(
          {
            ...session,
            participants: session.participants.map((p) =>
              p.userId === updated.userId ? updated : p,
            ),
          },
          settings ?? { itemId: input.itemId, deleted: true },
        ),
        input.caller.userId,
      );
    });
  },

  /**
   * Someone in a split changes how many ways it is divided — e.g. three
   * people shared it but the third only had a bite, so it's now two ways.
   * Only people in the split may change it; it can't go below the number
   * of people already in it, and it's frozen once any of them has paid
   * (their amount would change under them).
   */
  async setShareWays(input: {
    caller: VerifiedCaller;
    sessionId: string;
    itemId: string;
    ways: number;
  }): Promise<Session> {
    return withShareRetry(async () => {
      const session = await assertEditableSession(input.sessionId, input.caller.userId);
      const sharers = sharersOf(session, input.itemId);
      if (!sharers.includes(input.caller.userId)) {
        throw new AppError(
          'SHARE_CONFLICT',
          'Only people in this split can change how many ways it is split',
          {
            itemId: input.itemId,
          },
        );
      }
      const existing = settingsOf(session, input.itemId);
      const current = existing?.ways ?? sharers.length;
      if (input.ways === current) return projectForCaller(session, input.caller.userId);
      if (input.ways < sharers.length) {
        throw new AppError(
          'SHARE_WAYS_TOO_LOW',
          `${sharers.length} people are already in this split; someone needs to leave it before it can be split ${input.ways} ways`,
          { itemId: input.itemId, sharers: sharers.length },
        );
      }
      if (anySharerPaid(session, sharers)) {
        throw new AppError(
          'SHARE_PAID',
          "Someone in this split has already paid, so the number of ways can't change",
          { itemId: input.itemId },
        );
      }
      const settings: ShareSettings = {
        itemId: input.itemId,
        ways: input.ways,
        version: (existing?.version ?? 0) + 1,
        activity: pushActivity(existing?.activity, {
          kind: 'ways',
          byUserId: input.caller.userId,
          at: new Date().toISOString(),
          fromWays: current,
          toWays: input.ways,
        }),
      };
      await sessionStore.applyShareChange({
        sessionId: session.sessionId,
        itemId: input.itemId,
        settings,
        expectedVersion: existing?.version ?? null,
      });
      return projectForCaller(withSettings(session, settings), input.caller.userId);
    });
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
      owed = computeOwed(
        bill,
        session.participants,
        new Map((session.shareSettings ?? []).map((st) => [st.itemId, st.ways])),
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
/**
 * Common preamble for endpoints that mutate a participant's claims or
 * shares: fetch the session, assert the caller is a participant, and
 * assert the session is in a state where claims/shares can be edited
 * (creator in `setup`, anyone in `claiming`). Returns the fresh session.
 */
async function assertEditableSession(sessionId: string, userId: string): Promise<Session> {
  const session = await sessionStore.get(sessionId);
  if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
  const isCreator = session.creatorUserId === userId;
  const isParticipant = session.participants.some((p) => p.userId === userId);
  if (!isParticipant) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
  const allowed = (session.status === 'setup' && isCreator) || session.status === 'claiming';
  if (!allowed) {
    throw new AppError(
      'SESSION_INVALID_STATE',
      'Claims and shares cannot be modified in this state',
    );
  }
  return session;
}

function projectForCaller(session: Session, _callerUserId: string): Session {
  const { shareSettings, ...rest } = session;
  const withShares: Session = {
    ...rest,
    shares: computeShares(session.participants, shareSettings ?? []),
  };
  if (withShares.status === 'setup') {
    const { joinCode: _hidden, ...rest } = withShares;
    return rest;
  }
  return withShares;
}

/**
 * Derive the `shares` view from participants' sharedItemIds. One entry
 * per item that has at least one sharer; userIds is the splitter set.
 * Server-only; never stored.
 */
function computeShares(
  participants: ReadonlyArray<{ userId: string; sharedItemIds: string[] }>,
  settings: readonly ShareSettings[],
): NonNullable<Session['shares']> {
  const byItem = new Map<string, string[]>();
  for (const p of participants) {
    for (const itemId of p.sharedItemIds) {
      const list = byItem.get(itemId) ?? [];
      list.push(p.userId);
      byItem.set(itemId, list);
    }
  }
  return [...byItem.entries()].map(([itemId, userIds]) => {
    const st = settings.find((x) => x.itemId === itemId);
    return {
      itemId,
      userIds,
      // Splits from before `ways` existed: divide between whoever joined.
      ways: Math.max(st?.ways ?? userIds.length, userIds.length),
      activity: st?.activity ?? [],
    };
  });
}

function sharersOf(session: Session, itemId: string): string[] {
  return session.participants.filter((p) => p.sharedItemIds.includes(itemId)).map((p) => p.userId);
}

function settingsOf(session: Session, itemId: string): ShareSettings | undefined {
  return session.shareSettings?.find((st) => st.itemId === itemId);
}

function withSettings(
  session: Session,
  next: ShareSettings | { itemId: string; deleted: true },
): Session {
  const others = (session.shareSettings ?? []).filter((st) => st.itemId !== next.itemId);
  return { ...session, shareSettings: 'deleted' in next ? others : [...others, next] };
}

function anySharerPaid(session: Session, sharers: readonly string[]): boolean {
  return session.participants.some(
    (p) =>
      sharers.includes(p.userId) &&
      (p.payment.status === 'pending' || p.payment.status === 'succeeded'),
  );
}

function pushActivity(
  prev: readonly ShareActivity[] | undefined,
  next: ShareActivity,
): ShareActivity[] {
  return [...(prev ?? []), next].slice(-SHARE_ACTIVITY_KEEP);
}

/**
 * Split edits are read-modify-write on the split's settings row, guarded
 * by its version. If someone else changed the same split in between,
 * re-read and try again; give up after a few goes.
 */
async function withShareRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      if (attempt >= 3) {
        throw new AppError(
          'SHARE_CONFLICT',
          'Someone else changed this split at the same moment — try again',
        );
      }
    }
  }
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
