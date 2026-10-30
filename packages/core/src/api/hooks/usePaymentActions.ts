import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type Payment = components['schemas']['Payment'];

/** Lead confirms a manual payment was received. */
export function useConfirmPayment(sessionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<Payment, ApiError, string>({
    mutationFn: (paymentId) =>
      api<Payment>(`/v1/payments/${paymentId}/confirm`, { method: 'POST' }),
    onSuccess: () => {
      if (sessionId) void qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });
}

/** Payer claims they've sent the money via their bank. */
export function useMarkPaymentPaid(sessionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation<Payment, ApiError, string>({
    mutationFn: (paymentId) =>
      api<Payment>(`/v1/payments/${paymentId}/mark-paid`, { method: 'POST' }),
    onSuccess: () => {
      if (sessionId) void qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });
}
