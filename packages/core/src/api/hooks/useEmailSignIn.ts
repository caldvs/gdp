import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';
import { storeToken } from '../auth';

type User = components['schemas']['User'];

type SignedIn = {
  token: string;
  user: { userId: string; email: string; displayName: string };
};

/** Keep the session and switch the ['me'] cache to the new user. */
function useAdoptSession() {
  const qc = useQueryClient();
  return async ({ token, user }: SignedIn) => {
    await storeToken(token);
    qc.setQueryData<User>(['me'], user);
    // Drop any cached anonymous-state queries so the next reads pull
    // through with the new auth header.
    await qc.invalidateQueries({ queryKey: ['me'] });
  };
}

// Step 1: ask the server to email a sign-in link to this address. The
// response is the same for any well-formed email (no address enumeration,
// and SES bounces are 200 too), so success means "we tried", not "it
// arrived". It carries `requestId`: a secret this tab keeps and polls
// with until the link has been opened (useSignInRequest).
//
// An exempt address (TABLE_FEE_EXEMPT_EMAILS on the API) gets a session
// back instead: it's stored here, and `token` in the result tells the
// caller there's nothing to wait for.
export function useStartEmailSignIn() {
  const adopt = useAdoptSession();
  return useMutation<StartResponse, ApiError, { email: string }>({
    mutationFn: (body) => api<StartResponse>('/v1/auth/email/start', { method: 'POST', body }),
    onSuccess: async ({ token, user }) => {
      if (token && user) await adopt({ token, user });
    },
  });
}

type StartResponse = { ok: true; requestId?: string; token?: string; user?: SignedIn['user'] };

// The tab the emailed link opened: swap the link's token for a session.
// Every failure (used, expired, not ours) is a uniform 401 AUTH_INVALID.
export function useOpenSignInLink() {
  const adopt = useAdoptSession();
  return useMutation<SignedIn, ApiError, { token: string }>({
    mutationFn: (body) => api<SignedIn>('/v1/auth/email/link', { method: 'POST', body }),
    onSuccess: adopt,
  });
}

export type SignInRequestStatus =
  | { status: 'pending' }
  | ({ status: 'signedIn' } & SignedIn)
  | { status: 'expired' };

/** How often the tab that asked checks whether the link has been opened. */
export const SIGN_IN_POLL_MS = 2000;

// The tab that asked, waiting for the link to be opened (in another tab,
// another browser, or the mail app's). Polls every 2 seconds; once the
// server says `signedIn` this tab gets its own session and stops. The
// caller watches `data.status` to move on.
export function useSignInRequest(requestId: string | null) {
  const adopt = useAdoptSession();
  const q = useQuery<SignInRequestStatus, ApiError>({
    queryKey: ['signInRequest', requestId],
    enabled: !!requestId,
    queryFn: () =>
      api<SignInRequestStatus>('/v1/auth/email/requests', {
        method: 'POST',
        body: { requestId: requestId! },
      }),
    refetchInterval: (query) =>
      !query.state.data || query.state.data.status === 'pending' ? SIGN_IN_POLL_MS : false,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    retry: true,
    gcTime: 0,
  });
  const data = q.data;
  useEffect(() => {
    if (data?.status === 'signedIn') void adopt(data);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);
  return q;
}

// LOCAL DEVELOPMENT ONLY: sign in with just an email, no link. The local
// API server exposes /v1/auth/email/dev-sign-in (never deployed). A known
// email gets its existing account; a new one gets a new account. 404
// means the server doesn't offer it — callers fall back to the link flow.
export function useDevEmailSignIn() {
  const adopt = useAdoptSession();
  return useMutation<SignedIn, ApiError, { email: string }>({
    mutationFn: (body) => api<SignedIn>('/v1/auth/email/dev-sign-in', { method: 'POST', body }),
    onSuccess: adopt,
  });
}

// LOCAL AND DEV ONLY: sign in to a test account (@test.invalid) with no
// link. With `tabOnly`, only this tab signs in, so other tabs keep their
// user. 404 means the server has test accounts off.
export function useTestAccountSignIn() {
  const qc = useQueryClient();
  return useMutation<SignedIn, ApiError, { email: string; tabOnly?: boolean }>({
    mutationFn: ({ email }) =>
      api<SignedIn>('/v1/auth/email/test-sign-in', { method: 'POST', body: { email } }),
    onSuccess: async ({ token, user }, { tabOnly }) => {
      await storeToken(token, { tabOnly });
      // Everything else cached belongs to whoever was signed in before.
      // Keep the ['me'] query itself so screens watching it see the switch.
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      qc.setQueryData<User>(['me'], user);
    },
  });
}
