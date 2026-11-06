/** Helpers the session modules share: guards, retries and who-has-what on a line. */
import { AppError } from '../../errors/AppError.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { computeOwedForParticipant, paymentsOf, sentPence } from '../payments/ledger.js';
import { type Session, type Participant, type ShareSettings } from '../../types/sessions.js';

/**
 * Common preamble for endpoints that mutate a participant's claims or
 * shares: fetch the session, assert the caller is a participant, and
 * assert the session is in a state where claims/shares can be edited
 * (creator in `setup`, anyone in `claiming`). Returns the fresh session.
 */
export async function assertEditableSession(
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

export function sharersOf(session: Session, itemId: string): string[] {
  return session.participants.filter((p) => p.sharedItemIds.includes(itemId)).map((p) => p.userId);
}

export function settingsOf(session: Session, itemId: string): ShareSettings | undefined {
  return session.shareSettings?.find((st) => st.itemId === itemId);
}

/** Units of a line claimed one at a time, by anyone. */
export function claimedUnits(session: Session, itemId: string, exceptUserId?: string): number {
  return session.participants
    .filter((p) => p.userId !== exceptUserId)
    .reduce((acc, p) => acc + p.claimedItemIds.filter((c) => c === itemId).length, 0);
}

/** Units of a line a split covers; 0 when nobody is sharing it. */
export function sharedUnits(session: Session, itemId: string): number {
  if (sharersOf(session, itemId).length === 0) return 0;
  return settingsOf(session, itemId)?.units ?? 1;
}

/**
 * #121: once a guest has sent money, their claims can't drop below it, so
 * nobody is ever owed money back. Adding more is fine (they top up).
 */
export function assertNotBelowSent(
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

/** A participant's row changed under us more times than retrying could absorb. */
export const busy = () =>
  new AppError('SESSION_INVALID_STATE', 'Something changed at the same moment — try again');
