import { v7 as uuidv7 } from 'uuid';
import { billStore } from '../../storage/billStore.js';
import { sessionStore } from '../../storage/sessionStore.js';
import { AppError } from '../../errors/AppError.js';
import type { Bill, BillItem, AmendBillRequest } from '../../types/bills.js';

export const amendService = {
  async amend(input: {
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

    // Reject if a session has locked this bill (status >= paying).
    const lock = await sessionStore.getBillLock(input.billId);
    if (lock) {
      throw new AppError(
        'SESSION_INVALID_STATE',
        'Bill is locked: a session has entered the paying state',
        { sessionId: lock.sessionId },
      );
    }

    const items: BillItem[] = input.amendment.items.map((it) => ({
      itemId: it.itemId ?? uuidv7(),
      name: it.name,
      unitPricePence: it.unitPricePence,
      quantity: it.quantity,
      category: it.category,
    }));
    const subtotalPence = items.reduce((acc, i) => acc + i.unitPricePence * i.quantity, 0);
    const totalPence =
      subtotalPence + input.amendment.taxPence + input.amendment.serviceChargePence;

    const newVersion: Bill = {
      ...current,
      versionNumber: current.versionNumber + 1,
      items,
      subtotalPence,
      taxPence: input.amendment.taxPence,
      serviceChargePence: input.amendment.serviceChargePence,
      totalPence,
      createdAt: new Date().toISOString(),
    };

    await billStore.putVersion(newVersion);
    return newVersion;
  },
};
