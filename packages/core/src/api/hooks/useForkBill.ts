import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';
import { uuidv7 } from '../../lib/idempotency';

type Bill = components['schemas']['Bill'];
type ForkBillRequest = components['schemas']['ForkBillRequest'];

/**
 * Start again: a new bill for the same photo, from the latest version (the
 * default) or from what today's reader makes of it. The old bill and its
 * sessions stay as they are; the photo now opens the new bill.
 */
export function useForkBill() {
  const qc = useQueryClient();
  return useMutation<Bill, ApiError, { billId: string; from?: NonNullable<ForkBillRequest['from']> }>({
    mutationFn: ({ billId, from = 'latest' }) =>
      api<Bill>(`/v1/bills/${billId}/fork`, {
        method: 'POST',
        body: { from } satisfies ForkBillRequest,
        idempotencyKey: uuidv7(),
      }),
    onSuccess: (bill) => {
      qc.setQueryData(['bill', bill.billId, 'latest'], bill);
      qc.setQueryData(['bill', bill.billId, bill.versionNumber], bill);
    },
  });
}
