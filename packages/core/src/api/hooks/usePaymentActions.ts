import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type Payment = components['schemas']['Payment'];
type Session = components['schemas']['Session'];

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

/**
 * Lead saw a guest's money land (a banking app notification): everything
 * they owe now is received, whether or not they said they'd paid.
 */
export function useMarkReceived(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, string>({
    mutationFn: (userId) =>
      api<Session>(`/v1/sessions/${sessionId}/participants/${encodeURIComponent(userId)}/received`, {
        method: 'POST',
      }),
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
      void qc.invalidateQueries({ queryKey: ['my-sessions'] });
    },
  });
}
