import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type TableFeeCheckout = components['schemas']['TableFeeCheckout'];
type TableFeeStatus = components['schemas']['TableFeeStatus'];
type BillingSummary = components['schemas']['BillingSummary'];

/**
 * The lead's credits this month and the fees they've paid. `null` when the
 * API has no billing routes (Stripe not set up): no fees, no credits to show.
 */
export function useMyBilling(opts: { enabled?: boolean } = {}) {
  return useQuery<BillingSummary | null, ApiError>({
    queryKey: ['billing', 'me'],
    enabled: opts.enabled !== false,
    queryFn: async () => {
      try {
        return await api<BillingSummary>('/v1/billing/me');
      } catch (err) {
        if (err instanceof ApiError && err.status === 404 && err.code === 'NOT_FOUND') return null;
        throw err;
      }
    },
  });
}

/** "1 Dec" from `2026-12-01`: when the next credit comes. */
export function creditDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

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
    queryKey: ['billing', 'fee', billId],
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
