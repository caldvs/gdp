import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError, type components } from '../index';

export type Comment = components['schemas']['Comment'];

/** #218: the bill's comments, oldest first, polled like the session (every 5s). */
export function useComments(sessionId: string | undefined, opts: { poll?: boolean } = {}) {
  return useQuery<Comment[], ApiError>({
    queryKey: ['comments', sessionId],
    queryFn: async () => (await api<{ comments: Comment[] }>(`/v1/sessions/${sessionId}/comments`)).comments,
    enabled: !!sessionId,
    refetchInterval: opts.poll === false ? false : 5_000,
    staleTime: 0,
  });
}

export function usePostComment(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Comment, ApiError, { text: string }>({
    mutationFn: (body) => api<Comment>(`/v1/sessions/${sessionId}/comments`, { method: 'POST', body }),
    onSuccess: (comment) => {
      qc.setQueryData<Comment[]>(['comments', sessionId], (prev) =>
        prev?.some((c) => c.commentId === comment.commentId) ? prev : [...(prev ?? []), comment],
      );
    },
  });
}
