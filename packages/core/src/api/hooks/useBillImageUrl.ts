import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../index';

type ImageUrlResult = { url: string; expiresAt: string };

/**
 * Presigned URLs are short-lived (5 min). Fetched on demand when the
 * modal opens — `enabled` controls when the request actually fires.
 */
export function useBillImageUrl(billId: string | undefined, enabled: boolean) {
  return useQuery<ImageUrlResult, ApiError>({
    queryKey: ['bill-image-url', billId],
    queryFn: () => api<ImageUrlResult>(`/v1/bills/${billId}/image-url`),
    enabled: enabled && !!billId,
    staleTime: 4 * 60 * 1000,
    gcTime: 5 * 60 * 1000,
    retry: false,
  });
}
