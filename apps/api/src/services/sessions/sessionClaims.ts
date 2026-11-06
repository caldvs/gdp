/** Claiming lines one unit at a time, and saying you're done. */
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { billStore } from '../../storage/billStore.js';
import { retryOnConflict } from '../../storage/conflict.js';
import type { VerifiedCaller } from '../../context/caller.js';
import { type Session, type Participant, type ClaimsRequest } from '../../types/sessions.js';
import { projectForCaller } from './sessionView.js';
import { assertNotBelowSent, busy, claimedUnits, sharedUnits } from './sessionInternal.js';

export const claimMethods = {
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
};

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
