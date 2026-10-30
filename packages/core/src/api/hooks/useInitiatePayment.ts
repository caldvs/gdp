import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';
import { uuidv7 } from '../../lib/idempotency';

type InitiatePaymentResponse = components['schemas']['InitiatePaymentResponse'];

export function useInitiatePayment(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<InitiatePaymentResponse, ApiError, void>({
    mutationFn: () =>
      api<InitiatePaymentResponse>(`/v1/sessions/${sessionId}/payments`, {
        method: 'POST',
        idempotencyKey: uuidv7(),
      }),
    onSuccess: () => {
      // Force a re-fetch of the session so the participant.payment status
      // reflects 'pending' immediately.
      void qc.invalidateQueries({ queryKey: ['session', sessionId] });
    },
  });
}
