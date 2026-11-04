import { useEffect, useState } from 'react';
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
// with until the link has been opened (useSignInRequest), and `code`: the
// number this tab shows, which the link's page asks the person to check
// (#138).
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

type StartResponse = {
  ok: true;
  requestId?: string;
  code?: string;
  token?: string;
  user?: SignedIn['user'];
};

// The tab the emailed link opened, first: the number the asking tab shows,
// for the person to check before anything is signed in (#138). Spends
// nothing. A used, denied or expired link is a 401 AUTH_INVALID.
export function useSignInLinkCode() {
  return useMutation<{ code: string }, ApiError, { token: string }>({
    mutationFn: (body) =>
      api<{ code: string }>('/v1/auth/email/link/code', { method: 'POST', body }),
  });
}

// The person confirmed the number: swap the link's token for a session
// (and let the asking tab collect its own). Every failure (used, expired,
// not ours) is a uniform 401 AUTH_INVALID.
export function useOpenSignInLink() {
  const adopt = useAdoptSession();
  return useMutation<SignedIn, ApiError, { token: string; code: string }>({
    mutationFn: (body) => api<SignedIn>('/v1/auth/email/link', { method: 'POST', body }),
    onSuccess: adopt,
  });
}

// "That's not my number": someone else asked, so nobody is signed in.
export function useDenySignInLink() {
  return useMutation<{ ok: true }, ApiError, { token: string }>({
    mutationFn: (body) =>
      api<{ ok: true }>('/v1/auth/email/link/deny', { method: 'POST', body }),
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
//
// `signedIn` is final: polls can overlap (a refocus and the timer), and a
// later answer must never turn a sign-in back into `expired` (4 Nov 2026).
export function useSignInRequest(requestId: string | null) {
  const adopt = useAdoptSession();
  const [signedIn, setSignedIn] = useState<{ requestId: string; data: SignInRequestStatus } | null>(null);
  const done = !!requestId && signedIn?.requestId === requestId;
  const q = useQuery<SignInRequestStatus, ApiError>({
    queryKey: ['signInRequest', requestId],
    enabled: !!requestId && !done,
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
  const fetched = q.data;
  useEffect(() => {
    if (fetched?.status !== 'signedIn' || !requestId || done) return;
    setSignedIn({ requestId, data: fetched });
    void adopt(fetched);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched, requestId, done]);
  const data = done ? signedIn.data : fetched;
  return { ...q, data };
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
