import {
  billStore,
  summaryBillKey,
  summarySplitKey,
  type SummaryBill,
} from '../../storage/billStore.js';
import { sessionStore } from '../../storage/sessionStore.js';
import type { Participant, Session, ShareSettings } from '../../types/sessions.js';
import { computeOwedForParticipant } from '../payments/ledger.js';

type Summary = Awaited<ReturnType<typeof sessionStore.listForUser>>[number];
export type MySessionSummary = Omit<Summary, 'me'> & {
  billTotalPence?: number;
  mySharePence?: number;
  /** Open bills the caller leads (#223): everyone at the table, lead included. */
  peopleCount?: number;
  /** …and how many guests haven't paid yet. */
  toPayCount?: number;
};

const isOpen = (s: { status: Session['status'] }) =>
  s.status === 'claiming' || s.status === 'paying';

/**
 * GET /v1/me/sessions: the caller's sessions, each with the bill's total
 * and the caller's share of it. Three reads whatever the number of
 * sessions: the GSI1 query, a BatchGet of the META rows, then one BatchGet
 * of the pinned bill versions and the split rows the caller is in.
 */
export async function listMySessions(userId: string, limit: number): Promise<MySessionSummary[]> {
  const summaries = await sessionStore.listForUser(userId, limit);
  if (summaries.length === 0) return [];

  const { bills, splits } = await billStore.getVersionsAndSplits({
    bills: summaries.map((s) => ({ billId: s.billId, versionNumber: s.pinnedBillVersion })),
    splits: summaries.flatMap((s) =>
      (s.me?.sharedItemIds ?? []).map((itemId) => ({ sessionId: s.sessionId, itemId })),
    ),
  });

  // Who's at the table, for the open bills the caller leads: one query each,
  // and a lead has one or two open at a time.
  const tables = new Map(
    await Promise.all(
      summaries
        .filter((s) => s.role === 'lead' && isOpen(s))
        .map(
          async (s) => [s.sessionId, (await sessionStore.get(s.sessionId))?.participants] as const,
        ),
    ),
  );

  return summaries.map(({ me, ...summary }) => {
    const people = tables.get(summary.sessionId);
    const counts = people
      ? {
          peopleCount: people.length,
          toPayCount: people.filter(
            (p) => p.userId !== summary.creatorUserId && p.payment.status !== 'succeeded',
          ).length,
        }
      : {};
    const bill = bills.get(summaryBillKey(summary.billId, summary.pinnedBillVersion));
    if (!bill) return { ...summary, ...counts };
    const settings = (me?.sharedItemIds ?? []).flatMap((itemId) => {
      const st = splits.get(summarySplitKey(summary.sessionId, itemId));
      return st ? [st] : [];
    });
    return {
      ...summary,
      ...counts,
      billTotalPence: bill.totalPence,
      ...(me ? { mySharePence: sharePenceFor(bill, summary, me, settings) } : {}),
    };
  });
}

/**
 * What the caller owes (a guest) or ate (the lead), as the bill page works
 * it out: the locked `owedPence` once claims are locked, otherwise
 * computeOwedForParticipant on their claims and splits (the same maths as
 * owed.ts in core). The rest of each split comes from its SHARE# row's
 * `userIds`; a split from before those were kept counts the caller alone,
 * which can move the odd penny of its remainder.
 */
export function sharePenceFor(
  bill: SummaryBill,
  meta: Pick<Session, 'status' | 'creatorUserId' | 'platformFeePence'>,
  me: Participant,
  settings: readonly ShareSettings[],
): number {
  if (
    (meta.status === 'paying' || meta.status === 'settled') &&
    typeof me.owedPence === 'number' &&
    me.owedPence > 0
  ) {
    return me.owedPence;
  }
  const others = new Map<string, string[]>();
  for (const st of settings) {
    if (!(me.sharedItemIds ?? []).includes(st.itemId)) continue;
    for (const u of st.userIds ?? []) {
      if (u === me.userId) continue;
      others.set(u, [...(others.get(u) ?? []), st.itemId]);
    }
  }
  const participants: Participant[] = [
    me,
    ...[...others].map(([userId, sharedItemIds]) => ({
      userId,
      displayName: '',
      claimedItemIds: [],
      sharedItemIds,
      payment: { status: 'unpaid' as const },
      readyToLock: false,
    })),
  ];
  const session = {
    ...meta,
    participants,
    shareSettings: [...settings],
  } as unknown as Session;
  return computeOwedForParticipant(bill, session, me);
}
