import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type TableFeeCheckout = components['schemas']['TableFeeCheckout'];
type TableFeeStatus = components['schemas']['TableFeeStatus'];

/** Starts the embedded Stripe form for a bill's fee; resolves to its client secret. */
export function useStartTableFee() {
  return useMutation<TableFeeCheckout, ApiError, { billId: string }>({
    mutationFn: ({ billId }) =>
      api<TableFeeCheckout>('/v1/billing/table-fee', { method: 'POST', body: { billId } }),
  });
}

/**
 * Whether the fee is paid. Pass `poll` after confirming: the Stripe webhook,
 * not the browser, records the payment, so it can land a moment later.
 *
 * Resolves to `null` when the API has no billing routes (Stripe not set up),
 * which callers treat as "no fee".
 */
export function useTableFeeStatus(
  billId: string | undefined,
  opts: { poll?: boolean; enabled?: boolean } = {},
) {
  return useQuery<TableFeeStatus | null, ApiError>({
    queryKey: ['tableFee', billId],
    enabled: !!billId && opts.enabled !== false,
    queryFn: async () => {
      try {
        return await api<TableFeeStatus>(`/v1/billing/table-fee/${billId}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404 && err.code === 'NOT_FOUND') return null;
        throw err;
      }
    },
    refetchInterval: (query) =>
      opts.poll && query.state.data?.status === 'unpaid' ? 1000 : false,
  });
}
