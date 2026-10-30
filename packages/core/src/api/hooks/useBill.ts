import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type Bill = components['schemas']['Bill'];

export function useBill(billId: string | undefined) {
  return useQuery<Bill, ApiError>({
    queryKey: ['bill', billId],
    queryFn: () => api<Bill>(`/v1/bills/${billId}`),
    enabled: !!billId,
    staleTime: 30_000,
  });
}
