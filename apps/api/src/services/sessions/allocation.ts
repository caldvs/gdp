import {
  computeOwed as owedOnBill,
  splitsOf,
  unclaimedItemIds as unclaimedOnBill,
  type Split,
} from '@gdp/core/lib/owed';
import type { Bill } from '../../types/bills.js';
import type { Participant, Session } from '../../types/sessions.js';

/**
 * The split maths lives once, in packages/core/src/lib/owed.ts, for the API
 * and the app alike. These are the API's ways in: its sessions keep splits as
 * participants' `sharedItemIds` plus `shareSettings` (ways and units), here
 * also as maps by itemId.
 */
export { apportionByWeight, paymentsAreOpen, splitShare } from '@gdp/core/lib/owed';

type Claims = ReadonlyArray<
  Pick<Participant, 'userId' | 'claimedItemIds'> & {
    // Optional so tests from before ADR-0006 needn't add `sharedItemIds: []`.
    sharedItemIds?: readonly string[];
  }
>;

/** Splits from the participants, with each one's ways (missing: one per person) and units (missing: 1). */
function splitsFrom(
  participants: Claims,
  waysByItem: ReadonlyMap<string, number>,
  unitsByItem: ReadonlyMap<string, number>,
): Split[] {
  return splitsOf(participants).map((sp) => ({
    ...sp,
    ...(waysByItem.has(sp.itemId) ? { ways: waysByItem.get(sp.itemId)! } : {}),
    units: unitsByItem.get(sp.itemId) ?? 1,
  }));
}

/** Item IDs with a unit or a split spot nobody has. */
export function unclaimedOn(bill: Bill, session: Session): string[] {
  return unclaimedOnBill(
    bill.items,
    session.participants,
    splitsOf(session.participants, session.shareSettings ?? []),
  );
}

/** Lines not yet fully taken (see owed.ts unclaimedItemIds). */
export function unclaimedItemIds(
  bill: Pick<Bill, 'items'>,
  participants: Claims,
  waysByItem: ReadonlyMap<string, number> = new Map(),
  unitsByItem: ReadonlyMap<string, number> = new Map(),
): string[] {
  return unclaimedOnBill(
    bill.items,
    participants,
    splitsFrom(participants, waysByItem, unitsByItem),
  );
}

/**
 * Everyone's share of a fully claimed bill, to the penny (see owed.ts
 * computeOwed). Throws 'CLAIMS_INCOMPLETE' with `unclaimedItemIds`.
 */
export function computeOwed(
  bill: Pick<Bill, 'items' | 'taxPence' | 'serviceChargePence' | 'totalPence'> &
    Partial<Pick<Bill, 'discounts' | 'subtotalPence'>>,
  participants: Claims,
  // itemId → how many ways the split is divided. Missing → split between
  // whoever has joined (pre-`ways` behaviour).
  waysByItem: ReadonlyMap<string, number> = new Map(),
  // itemId → how many of the line the split covers. Missing → 1.
  unitsByItem: ReadonlyMap<string, number> = new Map(),
): Map<string, number> {
  return owedOnBill(
    { subtotalPence: 0, ...bill },
    participants,
    splitsFrom(participants, waysByItem, unitsByItem),
  );
}
