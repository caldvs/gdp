import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type Bill = components['schemas']['Bill'];
type AmendBillRequest = components['schemas']['AmendBillRequest'];

export function useAmendBill(billId: string) {
  const qc = useQueryClient();
  return useMutation<Bill, ApiError, AmendBillRequest>({
    mutationFn: (body) =>
      api<Bill>(`/v1/bills/${billId}/amend`, { method: 'POST', body }),
    onSuccess: (bill) => {
      qc.setQueryData(['bill', billId, 'latest'], bill);
      qc.setQueryData(['bill', billId, bill.versionNumber], bill);
      // Sessions pin a version; refetch so the table moves to the new one.
      void qc.invalidateQueries({ queryKey: ['session'] });
      // The table fee depends on the total (£2, or £3 over £100).
      void qc.invalidateQueries({ queryKey: ['tableFee', billId] });
    },
  });
}
