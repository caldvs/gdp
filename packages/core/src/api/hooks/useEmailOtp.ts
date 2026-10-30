import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';
import { storeToken } from '../auth';

type User = components['schemas']['User'];

// Step 1: ask the server to email a 6-digit code to this address.
// Response is uniform (`{ ok: true }`) for any well-formed email — the
// server doesn't tell us whether an account exists, by design (prevents
// address enumeration). Even SES bounces return 200 server-side, so a
// success here means "we tried", not "the email definitely arrived".
//
// Only 400 INVALID_INPUT (malformed email) is a real failure the UI
// surfaces. Anything else (5xx, network) bubbles up as ApiError too.
export function useStartEmailOtp() {
  return useMutation<{ ok: true }, ApiError, { email: string }>({
    mutationFn: (body) =>
      api<{ ok: true }>('/v1/auth/email/start', { method: 'POST', body }),
  });
}

type VerifyResponse = {
  token: string;
  user: { userId: string; email: string; displayName: string };
};

// Step 2: exchange a code for a session JWT. The server collapses every
// failure mode (wrong code / expired / used / 5-attempt lockout) into a
// uniform 401 AUTH_INVALID so a brute-forcer can't probe. The UI must
// not try to distinguish them — show the same "didn't work" copy and
// nudge the user toward Resend.
//
// On success: persist the token (so the next /v1/me succeeds) and prime
// the ['me'] cache with the returned user so the router can flip to the
// authed stack immediately without an extra round-trip.
export function useVerifyEmailOtp() {
  const qc = useQueryClient();
  return useMutation<VerifyResponse, ApiError, { email: string; code: string }>({
    mutationFn: (body) =>
      api<VerifyResponse>('/v1/auth/email/verify', { method: 'POST', body }),
    onSuccess: async ({ token, user }) => {
      await storeToken(token);
      qc.setQueryData<User>(['me'], user);
      // Drop any cached anonymous-state queries so the next reads pull
      // through with the new auth header.
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}

// LOCAL DEVELOPMENT ONLY: sign in with just an email, no code. The local
// API server exposes /v1/auth/email/dev-sign-in (never deployed). A known
// email gets its existing account; a new one gets a new account. 404
// means the server doesn't offer it — callers fall back to the code flow.
export function useDevEmailSignIn() {
  const qc = useQueryClient();
  return useMutation<VerifyResponse, ApiError, { email: string }>({
    mutationFn: (body) =>
      api<VerifyResponse>('/v1/auth/email/dev-sign-in', { method: 'POST', body }),
    onSuccess: async ({ token, user }) => {
      await storeToken(token);
      qc.setQueryData<User>(['me'], user);
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}
