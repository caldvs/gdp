/** How a session is shown to whoever asked: the shares view, #216's pay state, no join code in setup. */
import { billStore } from '../../storage/billStore.js';
import type { Bill } from '../../types/bills.js';
import { paymentsAreOpen, unclaimedOn } from './allocation.js';
import { type Session, type ShareSettings } from '../../types/sessions.js';

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

/**
 * Project the session for the caller. The join code is hidden from everyone
 * (including the creator) while the session is in `setup`; it becomes visible
 * once `share` activates the code.
 */
export async function projectForCaller(session: Session, _callerUserId: string): Promise<Session> {
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
