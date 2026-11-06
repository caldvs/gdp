import { uuidv7 } from '../../lib/uuid.js';
import { billStore } from '../../storage/billStore.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { AppError } from '../../errors/AppError.js';
import { retryOnConflict } from '../../storage/conflict.js';
import {
  BillSchema,
  discountPence,
  type Bill,
  type BillItem,
  type AmendBillRequest,
} from '../../types/bills.js';
import type { Participant } from '../../types/sessions.js';

export const amendService = {
  async amend(input: {
    billId: string;
    userId: string;
    amendment: AmendBillRequest;
  }): Promise<Bill> {
    // A guest claiming or paying while the lead edits changes their row;
    // the amend then re-reads and reconciles again.
    return retryOnConflict(
      () => amendOnce(input),
      () =>
        new AppError('SESSION_INVALID_STATE', 'Something changed at the same moment — try again'),
    );
  },
};

async function amendOnce(input: {
  billId: string;
  userId: string;
  amendment: AmendBillRequest;
}): Promise<Bill> {
  const current = await billStore.getLatest(input.billId);
  if (!current) {
    throw new AppError('BILL_NOT_FOUND', 'Bill not found');
  }
  if (current.creatorUserId !== input.userId) {
    // hide existence from non-creators
    throw new AppError('BILL_NOT_FOUND', 'Bill not found');
  }

  // If the bill is locked into a session, gate by session status.
  // - paying / settled: bill is frozen, totals are committed.
  // - setup / claiming: amend is allowed; session reconciles in lockstep.
  const lock = await sessionStore.getBillLock(input.billId);
  let session = lock ? await sessionStore.get(lock.sessionId) : null;
  if (session && (session.status === 'paying' || session.status === 'settled')) {
    throw new AppError(
      'SESSION_INVALID_STATE',
      'Bill is locked: a session has entered the paying state',
      { sessionId: session.sessionId },
    );
  }
  // Defensive: an abandoned session shouldn't keep its bill lock (abandon
  // releases it), but if it somehow lingers, treat as unlocked.
  if (session && session.status === 'abandoned') session = null;

  const items: BillItem[] = input.amendment.items.map((it) => ({
    itemId: it.itemId ?? uuidv7(),
    name: it.name,
    unitPricePence: it.unitPricePence,
    quantity: it.quantity,
    category: it.category,
    ...(it.category === 'food' && it.course ? { course: it.course } : {}),
  }));
  const subtotalPence = items.reduce((acc, i) => acc + i.unitPricePence * i.quantity, 0);
  // Absent keeps the bill's shared discounts; the lead can change or remove them.
  const discounts = input.amendment.discounts ?? current.discounts ?? [];
  const off = discountPence({ discounts });
  if (off > subtotalPence) {
    throw new AppError('INVALID_INPUT', 'The discount is more than the items come to', {
      fieldErrors: { discounts: ['More than the items come to'] },
    });
  }
  const totalPence =
    subtotalPence + input.amendment.taxPence + input.amendment.serviceChargePence - off;
  // A venue the lead chose beats whatever the parser found; sending
  // nothing keeps the bill's current venue (parsed or previously set).
  const venueOverride = input.amendment.venue;

  const newVersion: Bill = BillSchema.parse({
    ...current,
    versionNumber: current.versionNumber + 1,
    previousVersionId: current.billId,
    items,
    subtotalPence,
    taxPence: input.amendment.taxPence,
    serviceChargePence: input.amendment.serviceChargePence,
    discounts,
    totalPence,
    createdAt: new Date().toISOString(),
    ...(venueOverride ? { venue: venueOverride } : {}),
  });

  if (!session) {
    // No active session — simple version write.
    await billStore.putVersion(newVersion);
    return newVersion;
  }

  // Active session: reconcile claims and readiness against the new items.
  const newItemIds = new Set(items.map((i) => i.itemId));
  const newQty = new Map(items.map((i) => [i.itemId, i.quantity]));

  // Reject if any preserved itemId would have its quantity drop below the
  // total claim count for that item — the lead must clear those claims
  // first (or raise the quantity). This is a 409 the UI can explain.
  const wholeClaimsForItem = new Map<string, number>();
  for (const p of session.participants) {
    for (const id of p.claimedItemIds) {
      if (newItemIds.has(id)) {
        wholeClaimsForItem.set(id, (wholeClaimsForItem.get(id) ?? 0) + 1);
      }
    }
  }
  // A split holds its units of the line too.
  const shared = new Set(session.participants.flatMap((p) => p.sharedItemIds));
  for (const st of session.shareSettings ?? []) {
    if (newItemIds.has(st.itemId) && shared.has(st.itemId)) {
      const held = (wholeClaimsForItem.get(st.itemId) ?? 0) + (st.units ?? 1);
      wholeClaimsForItem.set(st.itemId, held);
    }
  }
  for (const [id, claimed] of wholeClaimsForItem) {
    const qty = newQty.get(id) ?? 0;
    if (claimed > qty) {
      throw new AppError(
        'CLAIMS_EXCEED_QUANTITY',
        'New quantity is below the number of claims for this item',
        { itemId: id, claimed, newQuantity: qty },
      );
    }
  }

  // Drop claims and splits for removed items; un-ready non-creator
  // participants so they re-confirm against the new bill. Creator's
  // readyToLock convention stays true.
  const updatedParticipants: Participant[] = session.participants.map((p) => {
    const isCreator = p.userId === session.creatorUserId;
    return {
      ...p,
      claimedItemIds: p.claimedItemIds.filter((id) => newItemIds.has(id)),
      sharedItemIds: p.sharedItemIds.filter((id) => newItemIds.has(id)),
      readyToLock: isCreator ? p.readyToLock : false,
    };
  });
  // A split's settings row goes with its line.
  const removedSplitItemIds = [
    ...new Set([
      ...(session.shareSettings ?? []).map((s) => s.itemId),
      ...session.participants.flatMap((p) => p.sharedItemIds),
    ]),
  ].filter((id) => !newItemIds.has(id));

  const { participants: _droppedParticipants, ...sessionMeta } = session;
  const updatedMeta = {
    ...sessionMeta,
    pinnedBillVersion: newVersion.versionNumber,
    // Session's venue is denormalised from the bill (sessionService.ts);
    // keep it in step when the lead changes it mid-session.
    ...(venueOverride ? { venue: venueOverride } : {}),
  };

  await billStore.applyAmendWithSession({
    bill: newVersion,
    sessionMeta: updatedMeta,
    participants: updatedParticipants,
    removedSplitItemIds,
  });
  return newVersion;
}
