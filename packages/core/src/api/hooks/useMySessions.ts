import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type SessionSummary = components['schemas']['SessionSummary'];
type ListResponse = { sessions: SessionSummary[] };

export function useMySessions(limit = 20) {
  return useQuery<ListResponse, ApiError>({
    queryKey: ['my-sessions', limit],
    queryFn: () => api<ListResponse>(`/v1/me/sessions?limit=${limit}`),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}

export type { SessionSummary };
