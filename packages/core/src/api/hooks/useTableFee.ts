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
 */
export function useTableFeeStatus(billId: string, opts: { poll?: boolean } = {}) {
  return useQuery<TableFeeStatus, ApiError>({
    queryKey: ['tableFee', billId],
    queryFn: () => api<TableFeeStatus>(`/v1/billing/table-fee/${billId}`),
    refetchInterval: (query) =>
      opts.poll && query.state.data?.status !== 'paid' ? 1000 : false,
  });
}
