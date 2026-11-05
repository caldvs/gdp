import { sessionStore } from '../../storage/sessionStore.js';
import type { Bill } from '../../types/bills.js';
import type { SessionStatus } from '../../types/sessions.js';

/**
 * Where the uploader's own bill for a repeat photo stands, so the app can
 * send them back to it (docs/design/analysis-cache.md, step 2): Review bill,
 * with "Picked up where you left off" when it was amended, or the bill's
 * table when it's in a session.
 */
export type DuplicateContext = {
  versionNumber: number;
  amended: boolean;
  /** The bill's live session (it holds the bill's lock), else its newest settled one. */
  session?: { sessionId: string; status: SessionStatus };
};

/** Resolved per request from the bill and its sessions: never cached. */
export async function duplicateContext(userId: string, bill: Bill): Promise<DuplicateContext> {
  return {
    versionNumber: bill.versionNumber,
    amended: bill.versionNumber > 1,
    ...(await sessionFor(userId, bill.billId)),
  };
}

async function sessionFor(
  userId: string,
  billId: string,
): Promise<Pick<DuplicateContext, 'session'>> {
  const lock = await sessionStore.getBillLock(billId);
  const locked = lock ? await sessionStore.get(lock.sessionId) : null;
  // Abandon releases the lock; a lingering one on an abandoned session counts as none.
  if (locked && locked.status !== 'abandoned') {
    return { session: { sessionId: locked.sessionId, status: locked.status } };
  }
  // Close releases the lock too, so a settled bill is found through the
  // lead's own sessions. Only the newest counts: abandoned after settled
  // means the lead had started again from this bill.
  const [newest] = (await sessionStore.sessionsForBill(userId, billId)).filter(
    (s) => s.creatorUserId === userId,
  );
  return newest?.status === 'settled'
    ? { session: { sessionId: newest.sessionId, status: newest.status } }
    : {};
}
