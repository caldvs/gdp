import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type Bill = components['schemas']['Bill'];

/**
 * A bill. Pass `version` (a session's `pinnedBillVersion`) on session
 * screens: the table shows the bill the session is pinned to, refetches
 * as soon as the lead's edit bumps it, and stays right after the lead
 * amends a closed bill.
 */
export function useBill(billId: string | undefined, version?: number) {
  return useQuery<Bill, ApiError>({
    queryKey: ['bill', billId, version ?? 'latest'],
    queryFn: () => api<Bill>(`/v1/bills/${billId}${version ? `?version=${version}` : ''}`),
    enabled: !!billId,
    staleTime: 30_000,
  });
}
