import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type TableFeeCheckout = components['schemas']['TableFeeCheckout'];
type TableFeeStatus = components['schemas']['TableFeeStatus'];
type BillingSummary = components['schemas']['BillingSummary'];
type SavedCardHold = components['schemas']['SavedCardHold'];
type FeeCharge = components['schemas']['FeeCharge'];
export type CardSummary = components['schemas']['CardSummary'];

/** "Visa ending 4417", or "Apple Pay": the saved card, in words (#228). */
export function cardLabel(card: CardSummary): string {
  const wallet: Record<string, string> = { apple_pay: 'Apple Pay', google_pay: 'Google Pay' };
  if (card.wallet && wallet[card.wallet]) return wallet[card.wallet]!;
  const brand: Record<string, string> = {
    visa: 'Visa',
    mastercard: 'Mastercard',
    amex: 'Amex',
  };
  const name = (card.brand && brand[card.brand]) ?? 'Card';
  return card.last4 ? `${name} ending ${card.last4}` : name;
}

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

/** #228: the £1 hold on the saved card, in one tap. */
export function useHoldOnSavedCard() {
  return useMutation<SavedCardHold, ApiError, { billId: string }>({
    mutationFn: ({ billId }) =>
      api<SavedCardHold>('/v1/billing/table-fee/saved-card', {
        method: 'POST',
        body: { billId },
      }),
  });
}

/** #228: the charge at settle the bank wants the lead to confirm. */
export function useFeeCharge(billId: string | undefined, opts: { poll?: boolean } = {}) {
  return useQuery<FeeCharge, ApiError>({
    queryKey: ['billing', 'fee-charge', billId],
    enabled: !!billId,
    queryFn: () => api<FeeCharge>(`/v1/billing/fee-charge/${billId}`),
    refetchInterval: (query) =>
      opts.poll && query.state.data?.status === 'needs_confirming' ? 1500 : false,
  });
}

/** #228: forget the saved card. */
export function useRemoveCard() {
  const qc = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationFn: () => api<void>('/v1/billing/card', { method: 'DELETE' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['billing', 'me'] }),
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
  opts: {
    poll?: boolean;
    enabled?: boolean;
    checkoutSessionId?: string | null;
    /** #228: a hold on the saved card the page just confirmed. */
    paymentIntentId?: string | null;
  } = {},
) {
  return useQuery<TableFeeStatus | null, ApiError>({
    queryKey: ['billing', 'fee', billId],
    enabled: !!billId && opts.enabled !== false,
    queryFn: async () => {
      const q = opts.checkoutSessionId
        ? `?session_id=${encodeURIComponent(opts.checkoutSessionId)}`
        : opts.paymentIntentId
          ? `?payment_intent=${encodeURIComponent(opts.paymentIntentId)}`
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
