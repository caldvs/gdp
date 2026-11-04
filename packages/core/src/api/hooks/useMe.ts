import { useQuery } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';
import { retryUnlessClientError } from '../retry';

type User = components['schemas']['User'];

/**
 * Who's signed in. `refetchOnMount: false` reads what the app shell already
 * asked: a page under the shell that asked again on mount would send a
 * signed-out visitor round a loop (the shell's spinner unmounts it, the
 * answer mounts it again, #183).
 */
export function useMe(opts: { refetchOnMount?: boolean } = {}) {
  return useQuery<User, ApiError>({
    queryKey: ['me'],
    queryFn: () => api<User>('/v1/me'),
    staleTime: 5 * 60 * 1000,
    retry: retryUnlessClientError,
    ...(opts.refetchOnMount === false ? { refetchOnMount: false, retryOnMount: false } : {}),
  });
}
