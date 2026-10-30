import type { QueryClient } from '@tanstack/react-query';
import { createFetcher, type RequestInit } from './client';
import { getStoredToken, clearToken } from './auth';

// The app calls `configureApi` once at start-up with its API origin.
// The hooks import `api` from here, so they work in any React app that
// has configured the base URL — no app-specific imports inside core.
let baseUrl = 'https://8yh705358k.execute-api.eu-west-2.amazonaws.com';
let queryClient: QueryClient | null = null;

export function configureApi(opts: { baseUrl: string }): void {
  baseUrl = opts.baseUrl;
}

export function getApiBaseUrl(): string {
  return baseUrl;
}

// The fetcher needs a way to bust the ['me'] cache after wiping a bad
// token; injection avoids a circular import on the providers tree.
export function registerQueryClient(qc: QueryClient): void {
  queryClient = qc;
}

export function api<T = unknown>(path: string, init?: RequestInit): Promise<T> {
  return createFetcher({
    baseUrl,
    getToken: getStoredToken,
    onAuthInvalid: async () => {
      // Stale token (e.g. left over from a previous backend config). Wipe
      // it and bust the me cache so the auth gate redirects to /sign-in
      // instead of looping on a token the server keeps rejecting.
      await clearToken();
      queryClient?.setQueryData(['me'], undefined);
      queryClient?.invalidateQueries({ queryKey: ['me'] });
    },
  })<T>(path, init);
}

export { ApiError } from './client';
export type { paths, components } from './client';
