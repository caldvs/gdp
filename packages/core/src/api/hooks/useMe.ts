import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';
import { retryUnlessClientError } from '../retry';

type User = components['schemas']['User'];

export function useMe() {
  return useQuery<User, ApiError>({
    queryKey: ['me'],
    queryFn: () => api<User>('/v1/me'),
    staleTime: 5 * 60 * 1000,
    retry: retryUnlessClientError,
  });
}
