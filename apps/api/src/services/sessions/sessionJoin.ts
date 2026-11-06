/** Reading and joining a table: by id, by its code, or as a guest with just a name. */
import { uuidv7 } from '../../lib/uuid.js';
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { billStore } from '../../storage/billStore.js';
import { isConditionalCheckFailed } from '../../storage/conflict.js';
import type { VerifiedCaller } from '../../context/caller.js';
import { type Session, type Participant, type SessionPreview } from '../../types/sessions.js';
import { projectForCaller } from './sessionView.js';

export const joinMethods = {
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
};
