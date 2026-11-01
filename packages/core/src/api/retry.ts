import { ApiError } from './client';

/**
 * React Query `retry`: try a failed query twice more, unless the API said
 * no. A 4xx (not found, forbidden, bad request) won't change on a retry,
 * and React Query pauses retries while the tab is in the background, so
 * retrying one can leave a screen loading until the user comes back.
 * Timeouts (408) and rate limits (429) are still retried.
 */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  ) {
    return false;
  }
  return failureCount < 2;
}
