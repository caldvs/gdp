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
 * Pass `checkoutSessionId` too, so the API can ask Stripe directly if the
 * webhook is late or never arrives.
 *
 * Resolves to `null` when the API has no billing routes (Stripe not set up),
 * which callers treat as "no fee".
 */
export function useTableFeeStatus(
  billId: string | undefined,
  opts: { poll?: boolean; enabled?: boolean; checkoutSessionId?: string | null } = {},
) {
  return useQuery<TableFeeStatus | null, ApiError>({
    queryKey: ['tableFee', billId],
    enabled: !!billId && opts.enabled !== false,
    queryFn: async () => {
      const q = opts.checkoutSessionId
        ? `?session_id=${encodeURIComponent(opts.checkoutSessionId)}`
        : '';
      try {
        return await api<TableFeeStatus>(`/v1/billing/table-fee/${billId}${q}`);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404 && err.code === 'NOT_FOUND') return null;
        throw err;
      }
    },
    refetchInterval: (query) =>
      opts.poll && query.state.data?.status === 'unpaid' ? 1500 : false,
  });
}
