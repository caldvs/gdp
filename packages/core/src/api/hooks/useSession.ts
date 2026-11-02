import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type Session = components['schemas']['Session'];
type User = components['schemas']['User'];

export function useSession(sessionId: string | undefined) {
  const qc = useQueryClient();
  const query = useQuery<Session, ApiError>({
    queryKey: ['session', sessionId],
    queryFn: () => api<Session>(`/v1/sessions/${sessionId}`),
    enabled: !!sessionId,
    // Poll briskly while the session is in flight; back off otherwise.
    refetchInterval: (q) => {
      const s = q.state.data;
      if (!s) return false;
      if (s.status === 'paying') return 3_000;
      if (s.status === 'claiming') return 5_000;
      return false;
    },
    staleTime: 0,
  });
  // The lead can fix the bill mid-session; the session carries the version
  // it's pinned to, so when that moves everyone refetches the bill.
  const version = query.data?.pinnedBillVersion;
  const billId = query.data?.billId;
  useEffect(() => {
    if (version === undefined || !billId) return;
    void qc.invalidateQueries({ queryKey: ['bill', billId] });
  }, [qc, billId, version]);
  return query;
}

export function useCreateSession() {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, { billId: string; expectedDiners?: number }>({
    mutationFn: ({ billId, expectedDiners }) =>
      api<Session>('/v1/sessions', {
        method: 'POST',
        body: { billId, ...(expectedDiners !== undefined ? { expectedDiners } : {}) },
      }),
    onSuccess: (session) => {
      qc.setQueryData(['session', session.sessionId], session);
      // A bill's status changed: the home list (Open / Past) must not show it stale.
      void qc.invalidateQueries({ queryKey: ['my-sessions'] });
    },
  });
}

export function useSetClaims(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, { claimedItemIds: string[] }, { previous?: Session }>({
    mutationFn: (body) =>
      api<Session>(`/v1/sessions/${sessionId}/claims`, { method: 'POST', body }),
    // Optimistic update so taps register instantly — also restores the
    // Storybook-drivable behaviour the previous mock-cache approach had
    // (fetch is stubbed in stories, so onSuccess never fires there).
    onMutate: async ({ claimedItemIds }) => {
      await qc.cancelQueries({ queryKey: ['session', sessionId] });
      const previous = qc.getQueryData<Session>(['session', sessionId]);
      const me = qc.getQueryData<User>(['me']);
      if (previous && me) {
        qc.setQueryData<Session>(['session', sessionId], {
          ...previous,
          participants: previous.participants.map((p) =>
            p.userId === me.userId
              ? {
                  ...p,
                  claimedItemIds,
                  // ADR-0006 mutual exclusion: claiming an item drops
                  // it from this user's share set if they were sharing
                  // it. Mirror that so the optimistic state matches.
                  sharedItemIds: p.sharedItemIds.filter(
                    (id) => !claimedItemIds.includes(id),
                  ),
                }
              : p,
          ),
          // Likewise prune the session.shares view so the row flips out
          // of share-mode immediately for everyone if this user was the
          // last sharer.
          shares: (previous.shares ?? [])
            .map((sh) =>
              claimedItemIds.includes(sh.itemId)
                ? { ...sh, userIds: sh.userIds.filter((id) => id !== me.userId) }
                : sh,
            )
            .filter((sh) => sh.userIds.length > 0),
        });
      }
      return { previous };
    },
    onError: (_e, _body, ctx) => {
      if (ctx?.previous) qc.setQueryData(['session', sessionId], ctx.previous);
    },
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
    },
  });
}

// ADR-0006: join the splitter set for an item. The endpoint returns the
// full updated Session, so no separate refetch is needed. We also
// optimistically update the cache so the row flips to share-mode the
// instant the user taps — matches the perceived latency the previous
// mock-only implementation had, and keeps Storybook stories drivable
// (fetch is stubbed there, so onSuccess never lands).
export function useAddShare(sessionId: string) {
  const qc = useQueryClient();
  // `ways` (how many people shared it) is only used when starting a split.
  return useMutation<Session, ApiError, { itemId: string; ways?: number }, { previous?: Session }>({
    mutationFn: (body) =>
      api<Session>(`/v1/sessions/${sessionId}/shares`, { method: 'POST', body }),
    onMutate: async ({ itemId, ways }) => {
      await qc.cancelQueries({ queryKey: ['session', sessionId] });
      const previous = qc.getQueryData<Session>(['session', sessionId]);
      const me = qc.getQueryData<User>(['me']);
      if (previous && me) {
        qc.setQueryData<Session>(['session', sessionId], applyAddShare(previous, itemId, me.userId, ways));
      }
      return { previous };
    },
    onError: (_e, _body, ctx) => {
      if (ctx?.previous) qc.setQueryData(['session', sessionId], ctx.previous);
    },
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
    },
  });
}

// ADR-0006: leave the splitter set for an item. Idempotent server-side.
// Mirrors useAddShare's optimistic-update pattern so the row flips back
// instantly on tap (and Storybook stories stay drivable without a real
// backend).
export function useRemoveShare(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, { itemId: string }, { previous?: Session }>({
    mutationFn: ({ itemId }) =>
      api<Session>(`/v1/sessions/${sessionId}/shares/${itemId}`, { method: 'DELETE' }),
    onMutate: async ({ itemId }) => {
      await qc.cancelQueries({ queryKey: ['session', sessionId] });
      const previous = qc.getQueryData<Session>(['session', sessionId]);
      const me = qc.getQueryData<User>(['me']);
      if (previous && me) {
        qc.setQueryData<Session>(
          ['session', sessionId],
          applyRemoveShare(previous, itemId, me.userId),
        );
      }
      return { previous };
    },
    onError: (_e, _body, ctx) => {
      if (ctx?.previous) qc.setQueryData(['session', sessionId], ctx.previous);
    },
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
    },
  });
}

// Someone in a split changes how many ways it's divided.
export function useSetShareWays(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, { itemId: string; ways: number }, { previous?: Session }>({
    mutationFn: ({ itemId, ways }) =>
      api<Session>(`/v1/sessions/${sessionId}/shares/${itemId}`, { method: 'PUT', body: { ways } }),
    onMutate: async ({ itemId, ways }) => {
      await qc.cancelQueries({ queryKey: ['session', sessionId] });
      const previous = qc.getQueryData<Session>(['session', sessionId]);
      if (previous) {
        qc.setQueryData<Session>(['session', sessionId], {
          ...previous,
          shares: (previous.shares ?? []).map((sh) => (sh.itemId === itemId ? { ...sh, ways } : sh)),
        });
      }
      return { previous };
    },
    onError: (_e, _body, ctx) => {
      if (ctx?.previous) qc.setQueryData(['session', sessionId], ctx.previous);
    },
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
    },
  });
}

// Pure transforms — exported for tests later if needed. The server is
// the source of truth; these mirror its behaviour for the optimistic
// window only (mutual exclusion with claims, dedup on re-add, prune
// empty share sets).
function applyAddShare(session: Session, itemId: string, userId: string, ways?: number): Session {
  const shares = [...(session.shares ?? [])];
  const idx = shares.findIndex((sh) => sh.itemId === itemId);
  if (idx >= 0) {
    const existing = shares[idx]!;
    if (!existing.userIds.includes(userId)) {
      const userIds = [...existing.userIds, userId];
      // Joining a split with every spot taken makes it one more way.
      shares[idx] = { ...existing, userIds, ways: Math.max(existing.ways, userIds.length) };
    }
  } else {
    shares.push({ itemId, userIds: [userId], ways: ways ?? 2, activity: [] });
  }
  const participants = session.participants.map((p) =>
    p.userId === userId
      ? {
          ...p,
          // ADR-0006 mutual exclusion: starting/joining a share drops
          // any unit claims this user had on the same item.
          claimedItemIds: p.claimedItemIds.filter((id) => id !== itemId),
          sharedItemIds: p.sharedItemIds.includes(itemId)
            ? p.sharedItemIds
            : [...p.sharedItemIds, itemId],
        }
      : p,
  );
  return { ...session, participants, shares };
}

function applyRemoveShare(session: Session, itemId: string, userId: string): Session {
  const shares = [...(session.shares ?? [])];
  const idx = shares.findIndex((sh) => sh.itemId === itemId);
  if (idx >= 0) {
    const existing = shares[idx]!;
    const userIds = existing.userIds.filter((id) => id !== userId);
    if (userIds.length === 0) shares.splice(idx, 1);
    else shares[idx] = { ...existing, userIds };
  }
  const participants = session.participants.map((p) =>
    p.userId === userId
      ? { ...p, sharedItemIds: p.sharedItemIds.filter((id) => id !== itemId) }
      : p,
  );
  return { ...session, participants, shares };
}

export function useShareSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, void>({
    mutationFn: () => api<Session>(`/v1/sessions/${sessionId}/share`, { method: 'POST' }),
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
      // A bill's status changed: the home list (Open / Past) must not show it stale.
      void qc.invalidateQueries({ queryKey: ['my-sessions'] });
    },
  });
}

export function useCloseSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, void>({
    mutationFn: () => api<Session>(`/v1/sessions/${sessionId}/close`, { method: 'POST' }),
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
      // A bill's status changed: the home list (Open / Past) must not show it stale.
      void qc.invalidateQueries({ queryKey: ['my-sessions'] });
    },
  });
}

/**
 * Email the caller their bill report: every diner for the lead, just
 * themselves for a guest. Everyone also gets one when the lead closes.
 */
export function useEmailReport(sessionId: string) {
  return useMutation<{ sent: boolean }, ApiError, void>({
    mutationFn: () => api<{ sent: boolean }>(`/v1/sessions/${sessionId}/report`, { method: 'POST' }),
  });
}

export function useAbandonSession(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, void>({
    mutationFn: () => api<Session>(`/v1/sessions/${sessionId}/abandon`, { method: 'POST' }),
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
      // A bill's status changed: the home list (Open / Past) must not show it stale.
      void qc.invalidateQueries({ queryKey: ['my-sessions'] });
    },
  });
}

/** #64: the lead says how many are eating (lead included); null clears it. */
export function useSetExpectedDiners(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, { expectedDiners: number | null }>({
    mutationFn: (body) =>
      api<Session>(`/v1/sessions/${sessionId}`, { method: 'PATCH', body }),
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
    },
  });
}

export function useSetReady(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, { ready: boolean }, { previous?: Session }>({
    mutationFn: (body) =>
      api<Session>(`/v1/sessions/${sessionId}/ready`, { method: 'POST', body }),
    // Optimistic update: flip the caller's readyToLock immediately so
    // the UI moves before the server confirms. Mirrors what the server
    // will do once the round-trip lands — and lets Storybook stories
    // (where fetch is stubbed) demonstrate the transition end-to-end.
    onMutate: async ({ ready }) => {
      await qc.cancelQueries({ queryKey: ['session', sessionId] });
      const previous = qc.getQueryData<Session>(['session', sessionId]);
      const me = qc.getQueryData<User>(['me']);
      if (previous && me) {
        qc.setQueryData<Session>(['session', sessionId], {
          ...previous,
          participants: previous.participants.map((p) =>
            p.userId === me.userId ? { ...p, readyToLock: ready } : p,
          ),
        });
      }
      return { previous };
    },
    onError: (_e, _body, ctx) => {
      if (ctx?.previous) qc.setQueryData(['session', sessionId], ctx.previous);
    },
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
    },
  });
}

export function useLockClaims(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Session, ApiError, { force?: boolean } | void>({
    mutationFn: (body) =>
      api<Session>(`/v1/sessions/${sessionId}/lock-claims`, {
        method: 'POST',
        body: body ?? {},
      }),
    onSuccess: (session) => {
      qc.setQueryData(['session', sessionId], session);
    },
  });
}
