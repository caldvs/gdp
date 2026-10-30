import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type PayoutAccount = components['schemas']['PayoutAccount'];
type SetResponse = { payoutAccount: PayoutAccount };

export function useSetPayoutAccount() {
  const qc = useQueryClient();
  return useMutation<SetResponse, ApiError, PayoutAccount>({
    mutationFn: (body) =>
      api<SetResponse>('/v1/me/payout-account', { method: 'PUT', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}
