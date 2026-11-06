/** Splits (ADR-0006, #130): joining, leaving and changing how many ways. */
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { billStore } from '../../storage/billStore.js';
import { retryOnConflict } from '../../storage/conflict.js';
import type { VerifiedCaller } from '../../context/caller.js';
import {
  SHARE_ACTIVITY_KEEP,
  SHARE_WAYS_MAX,
  type Session,
  type Participant,
  type ShareActivity,
  type ShareSettings,
} from '../../types/sessions.js';
import { projectForCaller } from './sessionView.js';
import {
  assertEditableSession,
  assertNotBelowSent,
  claimedUnits,
  settingsOf,
  sharersOf,
} from './sessionInternal.js';

export const shareMethods = {
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
};

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

/** A split's units carried into its next settings (absent on old splits: 1). */
function keepUnits(st: ShareSettings | undefined): { units?: number } {
  return st?.units ? { units: st.units } : {};
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
const withShareRetry = <T>(fn: () => Promise<T>): Promise<T> =>
  retryOnConflict(
    fn,
    () =>
      new AppError(
        'SHARE_CONFLICT',
        'Someone else changed this split at the same moment — try again',
      ),
  );
