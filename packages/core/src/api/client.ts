import { z } from 'zod';

export type { paths, components } from './schema';

const ErrorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string().optional(),
    details: z.unknown().optional(),
  }),
});

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetcherOptions = {
  baseUrl: string;
  getToken?: () => Promise<string | null> | string | null;
  // Called when the server tells us our token is no good (401 + AUTH_*).
  // Gives the app a chance to wipe storage + caches and bounce to sign-in
  // instead of looping on a token the server won't accept.
  onAuthInvalid?: () => void | Promise<void>;
};

export type RequestInit = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

export function createFetcher(opts: FetcherOptions) {
  return async function request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const url = new URL(path, opts.baseUrl);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
    if (opts.getToken) {
      const token = await opts.getToken();
      if (token) headers['authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(url, {
      method: init.method ?? 'GET',
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
    });

    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { /* not JSON */ }
      const env = ErrorEnvelope.safeParse(parsed);
      if (env.success) {
        const code = env.data.error.code;
        // Only treat AUTH_INVALID / AUTH_EXPIRED as needing remediation
        // — those mean we sent a token the server rejected and we
        // should wipe it. AUTH_MISSING means we never sent one in the
        // first place (normal unauthed state); clearing + invalidating
        // there just loops the same 401 forever.
        if (
          res.status === 401 &&
          (code === 'AUTH_INVALID' || code === 'AUTH_EXPIRED')
        ) {
          opts.onAuthInvalid?.();
        }
        throw new ApiError(
          res.status,
          code,
          env.data.error.message,
          env.data.error.requestId,
          env.data.error.details,
        );
      }
      throw new ApiError(res.status, 'UNKNOWN', text || res.statusText);
    }

    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };
}
