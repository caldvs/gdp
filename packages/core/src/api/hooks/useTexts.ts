import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

export type BillLinkView = components['schemas']['BillLinkView'];

/**
 * #220 G5: the bill behind a link in a guest's text. No sign-in. Live: it
 * re-reads every 30 seconds so it shows who still owes. A 404 means the
 * link has expired (30 days) and the page says so.
 */
export function useBillLink(token: string | undefined) {
  return useQuery<BillLinkView, ApiError>({
    queryKey: ['bill-link', token],
    queryFn: () => api<BillLinkView>(`/v1/links/${encodeURIComponent(token!)}`),
    enabled: !!token,
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
    refetchInterval: (q) => (q.state.error ? false : 30_000),
  });
}

/** #219: `/s/{token}`: no more reminders for this bill. */
export function useStopReminders() {
  return useMutation<{ stopped: boolean }, ApiError, string>({
    mutationFn: (token) =>
      api(`/v1/links/${encodeURIComponent(token)}/stop`, { method: 'POST' }),
  });
}

/** #220: a guest's receipt by email, from *All square*. */
export function useEmailReceipt(sessionId: string) {
  return useMutation<{ sent: boolean }, ApiError, string>({
    mutationFn: (email) =>
      api(`/v1/sessions/${sessionId}/receipt`, { method: 'POST', body: { email } }),
  });
}

export type GuestTexts = components['schemas']['GuestTexts'];
export type GuestRemind = components['schemas']['GuestRemind'];

/**
 * #219: what *Remind* can do for each guest, for the lead. `enabled: false`
 * where texts are off: the lead sees no *Remind*.
 */
export function useGuestTexts(sessionId: string, opts: { enabled?: boolean } = {}) {
  return useQuery<GuestTexts, ApiError>({
    queryKey: ['guest-texts', sessionId],
    queryFn: () => api<GuestTexts>(`/v1/sessions/${sessionId}/texts`),
    enabled: opts.enabled ?? true,
    staleTime: 30_000,
    retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
  });
}

/** #219: the lead taps *Remind* on a guest: one text. */
export function useRemind(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<GuestRemind, ApiError, string>({
    mutationFn: (userId) =>
      api(`/v1/sessions/${sessionId}/participants/${encodeURIComponent(userId)}/remind`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['guest-texts', sessionId] }),
  });
}
