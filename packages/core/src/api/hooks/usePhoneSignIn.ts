import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';
import { storeToken } from '../auth';

type User = components['schemas']['User'];
type SignedInUser = { userId: string; email: string; displayName: string };

/**
 * #213: which ways in this server has switched on. Phone sign-in shows
 * only where the WhatsApp app is set up; anything else (an older API, an
 * error) means email.
 */
export function useSignInMethods() {
  return useQuery<{ email: boolean; phone: boolean; whatsapp?: boolean; sms: boolean }>({
    queryKey: ['auth-methods'],
    queryFn: async () => {
      try {
        return await api('/v1/auth/methods');
      } catch {
        return { email: true, phone: false, whatsapp: false, sms: false };
      }
    },
    staleTime: 5 * 60 * 1000,
  });
}

function useAdopt() {
  const qc = useQueryClient();
  return async (token: string, user: SignedInUser) => {
    await storeToken(token);
    qc.setQueryData<User>(['me'], user as User);
    await qc.invalidateQueries({ queryKey: ['me'] });
  };
}

/** Send a 4-digit code by WhatsApp. `requestId` is this tab's secret. */
export function useStartPhoneSignIn() {
  return useMutation<{ ok: true; requestId: string; phone: string }, ApiError, { phone: string; channel?: 'whatsapp' | 'sms' }>({
    mutationFn: (body) => api('/v1/auth/phone/start', { method: 'POST', body }),
  });
}

export type PhoneCodeEntry =
  | { status: 'signedIn'; token: string; isNew: boolean; user: SignedInUser }
  | { status: 'wrong'; attemptsLeft: number }
  | { status: 'expired' };

export function useVerifyPhoneCode() {
  const adopt = useAdopt();
  return useMutation<PhoneCodeEntry, ApiError, { requestId: string; code: string }>({
    mutationFn: (body) => api('/v1/auth/phone/verify', { method: 'POST', body }),
    onSuccess: async (res) => {
      if (res.status === 'signedIn') await adopt(res.token, res.user);
    },
  });
}

/** Your name, and the email bill emails go to. Keeps the fresh token. */
export function useUpdateMe() {
  const adopt = useAdopt();
  return useMutation<{ token: string; user: SignedInUser }, ApiError, { displayName?: string; email?: string }>({
    mutationFn: (body) => api('/v1/me', { method: 'PATCH', body }),
    onSuccess: ({ token, user }) => adopt(token, user),
  });
}
