import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { billStore } from '../../storage/billStore.js';
import type { Bill } from '../../types/bills.js';
import { isConditionalCheckFailed, retryOnConflict } from '../../storage/conflict.js';
import { entitlementOps } from '../../storage/tableFeeStore.js';
import type { ShareEntitlement } from '../billing/tableFee.js';
import { generateJoinCode } from './joinCode.js';
import { computeOwed, paymentsAreOpen, unclaimedOn } from './allocation.js';
import {
  computeOwedForParticipant,
  feeFor,
  isSent,
  paymentsOf,
  roundUpPence,
  sentPence,
} from '../payments/ledger.js';
import type { VerifiedCaller } from '../../context/caller.js';
import {
  SHARE_ACTIVITY_KEEP,
  SHARE_WAYS_MAX,
  type Session,
  type Participant,
  type ClaimsRequest,
  type ShareActivity,
  type ShareSettings,
  type SessionPreview,
} from '../../types/sessions.js';

export type { VerifiedCaller };

const CODE_COLLISION_RETRIES = 3;

export const sessionService = {
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

  async get(input: { caller: VerifiedCaller; sessionId: string }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    const isParticipant = session.participants.some((p) => p.userId === input.caller.userId);
    if (!isParticipant) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    return projectForCaller(session, input.caller.userId);
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

  /**
   * The lead changes how many people are eating (#64), or clears it with
   * null. Lead only, and only while the bill is live.
   */
  async setExpectedDiners(input: {
    caller: VerifiedCaller;
    sessionId: string;
    expectedDiners: number | null;
  }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    if (session.creatorUserId !== input.caller.userId) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    if (session.status === 'settled' || session.status === 'abandoned') {
      throw new AppError('SESSION_INVALID_STATE', 'This bill is settled');
    }
    await sessionStore.setExpectedDiners(session.sessionId, input.expectedDiners);
    const { expectedDiners: _old, ...rest } = session;
    return projectForCaller(
      input.expectedDiners === null ? rest : { ...rest, expectedDiners: input.expectedDiners },
      input.caller.userId,
    );
  },

  /**
   * The lead's device publishes its fingerprint of the bank details in its
   * join link (#151), so guests' apps can tell if a link was altered. Lead
   * only, while the bill is live.
   */
  async setPayoutCheck(input: {
    caller: VerifiedCaller;
    sessionId: string;
    payoutCheck: string;
  }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    if (session.creatorUserId !== input.caller.userId) {
      throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    }
    if (session.status === 'settled' || session.status === 'abandoned') {
      throw new AppError('SESSION_INVALID_STATE', 'This bill is settled');
    }
    await sessionStore.setPayoutCheck(session.sessionId, input.payoutCheck);
    return projectForCaller({ ...session, payoutCheck: input.payoutCheck }, input.caller.userId);
  },

  /**
   * The landing page's view of a bill (#183), for whoever holds the QR:
   * host, venue, total, how many items, who's in (first names). Nothing
   * about bank details (ADR-0002).
   */
  async preview(input: { code: string }): Promise<SessionPreview> {
    const resolved = await sessionStore.resolveJoinCode(input.code);
    if (!resolved) throw new AppError('NOT_FOUND', 'Code not found');
    const session = await sessionStore.get(resolved.sessionId);
    if (!session || session.status === 'setup' || session.status === 'abandoned') {
      throw new AppError('NOT_FOUND', 'Code not active');
    }
    const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
    if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');
    const first = (name: string) => name.trim().split(/\s+/)[0] ?? name;
    const host = session.participants.find((p) => p.userId === session.creatorUserId);
    const others = session.participants.filter((p) => p.userId !== session.creatorUserId);
    return {
      sessionId: session.sessionId,
      status: session.status,
      hostName: first(host?.displayName ?? 'Your host'),
      ...(bill.venue?.name ? { venueName: bill.venue.name } : {}),
      createdAt: session.createdAt,
      itemCount: bill.items.reduce((n, it) => n + it.quantity, 0),
      totalPence: bill.totalPence,
      people: [host, ...others].filter((p) => !!p).map((p) => first(p.displayName)),
    };
  },

  /**
   * A guest joins with just a name (#183): a new user for this one table,
   * seated now. The route mints them a token that works for this session
   * only.
   */
  async joinAsGuest(input: {
    code: string;
    name: string;
    /** A guest id to seat (#214: one per verified code, so re-entering it doesn't seat them twice). */
    userId?: string;
  }): Promise<{ userId: string; session: Session }> {
    const { sessionId } = await this.resolveByCode({ code: input.code });
    const userId = input.userId ?? `guest-${uuidv7()}`;
    const session = await this.join({ caller: { userId, displayName: input.name }, sessionId });
    return { userId, session };
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
   * What the lead is charged from their hold (4 Nov 2026): the round-ups of
   * the guests whose payment the lead confirmed. When guests say they've
   * paid but the lead confirmed none, the whole hold. The caller caps it at
   * the hold. Reads the stored session (with each split's ways) and the
   * pinned bill. 0 when no hold paid for it.
   */
  async guestsFeePence(sessionId: string): Promise<number> {
    const session = await sessionStore.get(sessionId);
    if (!session?.platformFeePence) return 0;
    const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
    if (!bill) return 0;
    const guests = session.participants.filter((p) => p.userId !== session.creatorUserId);
    const confirmed = guests.filter((p) => paymentsOf(p, 0).some((e) => e.status === 'succeeded'));
    if (confirmed.length === 0 && guests.some((p) => paymentsOf(p, 0).some(isSent))) {
      return session.platformFeePence;
    }
    return confirmed.reduce((acc, p) => acc + feeFor(bill, session, p), 0);
  },

  async join(input: { caller: VerifiedCaller; sessionId: string }): Promise<Session> {
    const session = await sessionStore.get(input.sessionId);
    if (!session) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
    // Someone already at the table gets back in whatever the state, e.g. a
    // guest reopening the link to pay after the lead has closed the bill.
    if (session.participants.some((p) => p.userId === input.caller.userId)) {
      return projectForCaller(session, input.caller.userId);
    }
    if (session.status !== 'claiming') {
      throw new AppError(
        'SESSION_INVALID_STATE',
        session.status === 'settled'
          ? 'This bill has been closed'
          : 'Session is not accepting joins',
        { status: session.status },
      );
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
    try {
      await sessionStore.addParticipant(session.sessionId, newParticipant);
    } catch (err) {
      // Joined twice at once: the other request got them in, so this one
      // returns the table as it is rather than wiping their row.
      if (!isConditionalCheckFailed(err)) throw err;
      const now = await sessionStore.get(session.sessionId);
      if (!now) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
      return projectForCaller(now, input.caller.userId);
    }

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
    // Read, validate, then write only if nobody changed who-has-what in
    // between (two guests taking the last unit at once). On a clash,
    // re-read and validate again: the loser then sees the item is gone.
    return withClaimsRetry(() => setClaimsOnce(input));
  },

  /**
   * Caller joins the splitter set for `itemId` (ADR-0006). Idempotent —
   * a no-op if already in the set. Returns the updated session.
   *
   * On a quantity-1 line, if someone else has claimed the item (#130),
   * splitting it turns their claim into a split between the two of them
   * at once: they're told, not asked (decisions.md). Refused with
   * SHARE_PAID if they've already paid, since what they paid can't change.
   * The caller's own claim must be released first.
   *
   * On a longer line the split covers `units` of it (default: every unit
   * nobody has claimed), taken from what's left; the rest is still
   * claimed one at a time.
   */
  async addShare(input: {
    caller: VerifiedCaller;
    sessionId: string;
    itemId: string;
    /** How many people shared it — only used when starting the split. */
    ways?: number;
    /** How many of a multi-quantity line it covers — only used when starting. */
    units?: number;
  }): Promise<Session> {
    return withShareRetry(async () => {
      const { session, claimsVersion } = await assertEditableSession(
        input.sessionId,
        input.caller.userId,
      );
      const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
      if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');
      const item = bill.items.find((it) => it.itemId === input.itemId);
      if (!item) {
        throw new AppError('INVALID_INPUT', 'Unknown itemId', { itemId: input.itemId });
      }
      const multi = item.quantity > 1;
      const claimer = multi
        ? undefined
        : session.participants.find((p) => p.claimedItemIds.includes(input.itemId));
      if (claimer && claimer.userId === input.caller.userId) {
        throw new AppError(
          'CLAIM_SHARE_CONFLICT',
          `You've claimed "${item.name}"; remove it before splitting it`,
          { itemId: input.itemId },
        );
      }
      if (claimer) {
        if (anySharerPaid(session, [claimer.userId])) {
          throw new AppError(
            'SHARE_PAID',
            `${claimer.displayName} has already paid for "${item.name}", so it can't be split`,
            { itemId: input.itemId },
          );
        }
        return splitClaimed({
          session,
          claimsVersion,
          claimer,
          caller: input.caller,
          itemId: input.itemId,
          ways: input.ways,
        });
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
        // Starting the split: the starter says how many people shared it,
        // and on a longer line how many of it.
        const ways = input.ways ?? 2;
        const left = item.quantity - claimedUnits(session, input.itemId);
        const units = multi ? (input.units ?? left) : 1;
        if (units < 1 || units > left) {
          throw new AppError(
            'SESSION_INVALID_STATE',
            left < 1
              ? `All of "${item.name}" has been claimed`
              : `Only ${left} of "${item.name}" left to split`,
            { itemId: input.itemId, units, available: Math.max(0, left) },
          );
        }
        settings = {
          itemId: input.itemId,
          ways,
          units,
          userIds: [input.caller.userId],
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
          ...keepUnits(existing),
          userIds: [...sharers, input.caller.userId],
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
        expectedClaimsVersion: claimsVersion,
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
      const { session, claimsVersion } = await assertEditableSession(
        input.sessionId,
        input.caller.userId,
      );
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
      const bill = await billStore.getVersion(session.billId, session.pinnedBillVersion);
      if (bill) assertNotBelowSent(bill, session, target, updated);
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
              ...keepUnits(existing),
              userIds: sharers.filter((u) => u !== input.caller.userId),
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
        expectedClaimsVersion: claimsVersion,
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
      const { session } = await assertEditableSession(input.sessionId, input.caller.userId);
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
        ...keepUnits(existing),
        userIds: sharers,
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
    return retryOnConflict(async () => {
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
        throw new AppError(
          'SESSION_INVALID_STATE',
          'Creator does not signal ready; use lock-claims',
        );
      }

      const updated: Participant = { ...target, readyToLock: input.ready };
      await sessionStore.putParticipant(session.sessionId, updated);
      return projectForCaller(
        {
          ...session,
          participants: session.participants.map((p) =>
            p.userId === updated.userId ? updated : p,
          ),
        },
        input.caller.userId,
      );
    }, busy);
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
async function assertEditableSession(
  sessionId: string,
  userId: string,
): Promise<{ session: Session; claimsVersion: number }> {
  const loaded = await sessionStore.getWithClaimsVersion(sessionId);
  if (!loaded) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
  const { session } = loaded;
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
  return loaded;
}

// Bill versions never change once written, so a warm Lambda keeps the few
// it has read for the session view's allClaimed (#216).
const billVersions = new Map<string, Promise<Bill | null>>();
function pinnedBill(session: Session): Promise<Bill | null> {
  const key = `${session.billId}#${session.pinnedBillVersion}`;
  let bill = billVersions.get(key);
  if (!bill) {
    if (billVersions.size >= 200) billVersions.delete(billVersions.keys().next().value!);
    bill = billStore.getVersion(session.billId, session.pinnedBillVersion);
    billVersions.set(key, bill);
    bill.catch(() => billVersions.delete(key));
  }
  return bill;
}

/** #216: the view says whether every line is claimed and whether payments are open. */
async function payState(session: Session): Promise<{ allClaimed: boolean; paymentsOpen: boolean }> {
  if (session.status === 'setup') return { allClaimed: false, paymentsOpen: false };
  const bill = await pinnedBill(session);
  const allClaimed = !!bill && unclaimedOn(bill, session).length === 0;
  return { allClaimed, paymentsOpen: paymentsAreOpen(session, allClaimed) };
}

async function projectForCaller(session: Session, _callerUserId: string): Promise<Session> {
  const { shareSettings, allClaimed: _ac, paymentsOpen: _po, ...rest } = session;
  const withShares: Session = {
    ...rest,
    ...(await payState(session)),
    // rev is storage's (see participantPutOp), not the client's.
    participants: session.participants.map(({ rev: _rev, ...p }) => p),
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
      units: st?.units ?? 1,
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

/** A split's units carried into its next settings (absent on old splits: 1). */
function keepUnits(st: ShareSettings | undefined): { units?: number } {
  return st?.units ? { units: st.units } : {};
}

/** Units of a line claimed one at a time, by anyone. */
function claimedUnits(session: Session, itemId: string, exceptUserId?: string): number {
  return session.participants
    .filter((p) => p.userId !== exceptUserId)
    .reduce((acc, p) => acc + p.claimedItemIds.filter((c) => c === itemId).length, 0);
}

/** Units of a line a split covers; 0 when nobody is sharing it. */
function sharedUnits(session: Session, itemId: string): number {
  if (sharersOf(session, itemId).length === 0) return 0;
  return settingsOf(session, itemId)?.units ?? 1;
}

function withSettings(
  session: Session,
  next: ShareSettings | { itemId: string; deleted: true },
): Session {
  const others = (session.shareSettings ?? []).filter((st) => st.itemId !== next.itemId);
  return { ...session, shareSettings: 'deleted' in next ? others : [...others, next] };
}

/**
 * #130: the caller splits an item someone else has claimed. The claimer's
 * claim becomes their spot in a split with the caller (`ways`, default 2),
 * in one transaction guarded by the claims version, so a claim or split
 * landing in between makes it re-read.
 */
async function splitClaimed(input: {
  session: Session;
  claimsVersion: number;
  claimer: Participant;
  caller: VerifiedCaller;
  itemId: string;
  ways: number | undefined;
}): Promise<Session> {
  const { session, claimer, caller, itemId } = input;
  const target = session.participants.find((p) => p.userId === caller.userId);
  if (!target) throw new Error('Invariant: caller participant missing');
  // Same as any claim change: it un-readies everyone but the lead.
  const ready = (p: Participant): boolean =>
    p.userId === session.creatorUserId ? p.readyToLock : false;
  const i = claimer.claimedItemIds.indexOf(itemId);
  const was: Participant = {
    ...claimer,
    claimedItemIds: claimer.claimedItemIds.filter((_, k) => k !== i),
    sharedItemIds: [...claimer.sharedItemIds, itemId],
    readyToLock: ready(claimer),
  };
  const updated: Participant = {
    ...target,
    sharedItemIds: [...target.sharedItemIds, itemId],
    readyToLock: ready(target),
  };
  const existing = settingsOf(session, itemId);
  const ways = Math.max(2, input.ways ?? 2);
  const settings: ShareSettings = {
    itemId,
    ways,
    userIds: [...new Set([...sharersOf(session, itemId), claimer.userId, caller.userId])],
    version: (existing?.version ?? 0) + 1,
    activity: [
      {
        kind: 'split',
        byUserId: caller.userId,
        fromUserId: claimer.userId,
        at: new Date().toISOString(),
        toWays: ways,
      },
    ],
  };
  await sessionStore.applyShareChange({
    sessionId: session.sessionId,
    participant: updated,
    others: [was],
    itemId,
    settings,
    expectedVersion: existing?.version ?? null,
    expectedClaimsVersion: input.claimsVersion,
  });
  return projectForCaller(
    withSettings(
      {
        ...session,
        participants: session.participants.map((p) =>
          p.userId === updated.userId ? updated : p.userId === was.userId ? was : p,
        ),
      },
      settings,
    ),
    caller.userId,
  );
}

/**
 * #121: once a guest has sent money, their claims can't drop below it, so
 * nobody is ever owed money back. Adding more is fine (they top up).
 */
function assertNotBelowSent(
  bill: Parameters<typeof computeOwedForParticipant>[0],
  session: Session,
  before: Participant,
  after: Participant,
): void {
  if (before.userId === session.creatorUserId) return;
  const sent = sentPence(paymentsOf(before, computeOwedForParticipant(bill, session, before)));
  if (sent === 0) return;
  const afterSession = {
    ...session,
    participants: session.participants.map((p) => (p.userId === after.userId ? after : p)),
  };
  const owed = computeOwedForParticipant(bill, afterSession, after);
  if (owed < sent) {
    throw new AppError('ALREADY_PAID_FOR', 'You’ve already paid for that', {
      sentPence: sent,
      owedPence: owed,
    });
  }
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

async function setClaimsOnce(input: {
  caller: VerifiedCaller;
  sessionId: string;
  claims: ClaimsRequest;
}): Promise<Session> {
  const loaded = await sessionStore.getWithClaimsVersion(input.sessionId);
  if (!loaded) throw new AppError('SESSION_NOT_FOUND', 'Session not found');
  const { session, claimsVersion } = loaded;

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
    // ADR-0006: a quantity-1 item is claimed or shared, not both. If
    // anyone (including the caller) currently shares it we refuse the
    // claim — they must leave the share first via DELETE
    // /v1/sessions/:id/shares/:itemId. On a longer line a split holds its
    // units and the rest can be claimed.
    const shared = sharedUnits(session, id);
    if (shared > 0 && item.quantity === 1) {
      throw new AppError(
        'CLAIM_SHARE_CONFLICT',
        `"${item.name}" is currently being shared; leave the share before claiming`,
        { itemId: id },
      );
    }
    // Everyone else's claims, plus any split, plus mine must fit the line.
    const available = item.quantity - shared - claimedUnits(session, id, input.caller.userId);
    if (count > available) {
      throw new AppError(
        'SESSION_INVALID_STATE',
        `Only ${available} of "${item.name}" left to claim`,
        { itemId: id, claimed: count, available },
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
  assertNotBelowSent(bill, session, target, updated);
  await sessionStore.putClaimsGuarded(session.sessionId, updated, claimsVersion);

  return projectForCaller(
    {
      ...session,
      participants: session.participants.map((p) => (p.userId === updated.userId ? updated : p)),
    },
    input.caller.userId,
  );
}

/**
 * Claim writes are conditional on the session's claims version. A clash
 * means someone else's claim, split or bill edit landed first: back off a
 * moment, re-read and try again. Simultaneous claims for different things
 * all succeed after a retry or two.
 */
const withClaimsRetry = <T>(fn: () => Promise<T>): Promise<T> =>
  retryOnConflict(
    fn,
    () =>
      new AppError('SESSION_INVALID_STATE', 'The bill changed while you were choosing — try again'),
  );

/**
 * Split edits are read-modify-write on the split's settings row, guarded
 * by its version. If someone else changed the same split in between,
 * re-read and try again; give up after a few goes.
 */
const withShareRetry = <T>(fn: () => Promise<T>): Promise<T> =>
  retryOnConflict(
    fn,
    () =>
      new AppError(
        'SHARE_CONFLICT',
        'Someone else changed this split at the same moment — try again',
      ),
  );

/** A participant's row changed under us more times than retrying could absorb. */
const busy = () =>
  new AppError('SESSION_INVALID_STATE', 'Something changed at the same moment — try again');
