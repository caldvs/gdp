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

// Step 1: ask the server to email a 6-digit code to this address. The
// response is the same for any well-formed email (no address enumeration,
// and SES bounces are 200 too), so success means "we tried", not "it
// arrived". It carries `requestId`: a secret this tab keeps and sends with
// the code (useVerifyEmailCode), so only this tab can use it.
//
// An exempt address (TABLE_FEE_EXEMPT_EMAILS on the API) gets a session
// back instead: it's stored here, and `token` in the result tells the
// caller there's nothing to enter.
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
  token?: string;
  user?: SignedIn['user'];
};

export type CodeEntry =
  | ({ status: 'signedIn' } & SignedIn)
  | { status: 'wrong'; attemptsLeft: number }
  | { status: 'expired' };

// Step 2: the code the person typed (or their phone filled in). `signedIn`
// keeps the session; `wrong` says how many tries are left; `expired` means
// ask for a new code. All three are 200s, so a wrong code never looks like
// a bad session token to the client.
export function useVerifyEmailCode() {
  const adopt = useAdoptSession();
  return useMutation<CodeEntry, ApiError, { requestId: string; code: string }>({
    mutationFn: (body) => api<CodeEntry>('/v1/auth/email/verify', { method: 'POST', body }),
    onSuccess: async (res) => {
      if (res.status === 'signedIn') await adopt(res);
    },
  });
}

// LOCAL DEVELOPMENT ONLY: sign in with just an email, no code. The local
// API server exposes /v1/auth/email/dev-sign-in (never deployed). A known
// email gets its existing account; a new one gets a new account. 404
// means the server doesn't offer it — callers fall back to the code.
export function useDevEmailSignIn() {
  const adopt = useAdoptSession();
  return useMutation<SignedIn, ApiError, { email: string }>({
    mutationFn: (body) => api<SignedIn>('/v1/auth/email/dev-sign-in', { method: 'POST', body }),
    onSuccess: adopt,
  });
}

// LOCAL AND DEV ONLY: sign in to a test account (@test.invalid) with no
// code. With `tabOnly`, only this tab signs in, so other tabs keep their
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
