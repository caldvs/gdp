import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';

type User = components['schemas']['User'];

export function useMe() {
  return useQuery<User, ApiError>({
    queryKey: ['me'],
    queryFn: () => api<User>('/v1/me'),
    staleTime: 5 * 60 * 1000,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        return false;
      }
      return failureCount < 2;
    },
  });
}
