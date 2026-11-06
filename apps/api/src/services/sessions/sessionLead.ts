/** Settings only the lead changes while the bill is live. */
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import type { VerifiedCaller } from '../../context/caller.js';
import { type Session } from '../../types/sessions.js';
import { projectForCaller } from './sessionView.js';

export const leadMethods = {
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
};
