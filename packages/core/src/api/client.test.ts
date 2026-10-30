import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFetcher, ApiError } from './client';

// Tests for the createFetcher transport. This is where every API call
// goes through — auth header, error envelope, AUTH_MISSING vs
// AUTH_INVALID branching, etc. The same regressions we hit in iOS
// debugging (infinite loop on AUTH_MISSING) are pinned here.

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

const baseUrl = 'https://example.test';

describe('createFetcher', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GETs the right URL and parses JSON', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { hello: 'world' }));
    const api = createFetcher({ baseUrl });
    const out = await api<{ hello: string }>('/v1/thing');
    expect(out).toEqual({ hello: 'world' });
    const calledUrl = fetchSpy.mock.calls[0][0];
    expect(calledUrl.toString()).toBe(`${baseUrl}/v1/thing`);
  });

  it('POSTs the body with content-type', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, { ok: true }));
    const api = createFetcher({ baseUrl });
    await api('/v1/thing', { method: 'POST', body: { x: 1 } });
    const init = fetchSpy.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ x: 1 });
  });

  it('includes the Bearer token from getToken()', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {}));
    const api = createFetcher({ baseUrl, getToken: () => 'abc' });
    await api('/v1/thing');
    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers.authorization).toBe('Bearer abc');
  });

  it('omits the Authorization header when getToken returns null', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {}));
    const api = createFetcher({ baseUrl, getToken: () => null });
    await api('/v1/thing');
    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers.authorization).toBeUndefined();
  });

  it('appends query parameters', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {}));
    const api = createFetcher({ baseUrl });
    await api('/v1/thing', { query: { limit: 10, offset: 0, missing: undefined } });
    const url = fetchSpy.mock.calls[0][0].toString();
    expect(url).toContain('limit=10');
    expect(url).toContain('offset=0');
    expect(url).not.toContain('missing');
  });

  it('forwards an idempotency-key header', async () => {
    fetchSpy.mockResolvedValue(jsonResponse(200, {}));
    const api = createFetcher({ baseUrl });
    await api('/v1/thing', { method: 'POST', body: {}, idempotencyKey: 'k1' });
    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers['idempotency-key']).toBe('k1');
  });

  it('returns undefined for 204 No Content', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 204 }));
    const api = createFetcher({ baseUrl });
    const out = await api('/v1/thing', { method: 'DELETE' });
    expect(out).toBeUndefined();
  });

  it('throws ApiError with parsed code for a 4xx error envelope', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(400, {
        error: { code: 'INVALID_INPUT', message: 'bad email' },
      }),
    );
    const api = createFetcher({ baseUrl });
    await expect(api('/v1/thing')).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_INPUT',
      message: 'bad email',
    });
  });

  it('throws ApiError with UNKNOWN code for a non-JSON error', async () => {
    fetchSpy.mockResolvedValue(textResponse(500, 'something broke'));
    const api = createFetcher({ baseUrl });
    const err = await api('/v1/thing').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(500);
    expect((err as ApiError).code).toBe('UNKNOWN');
  });

  describe('onAuthInvalid branching', () => {
    it('FIRES onAuthInvalid for 401 AUTH_INVALID', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(401, { error: { code: 'AUTH_INVALID', message: 'go' } }),
      );
      const cb = vi.fn();
      const api = createFetcher({ baseUrl, onAuthInvalid: cb });
      await expect(api('/v1/thing')).rejects.toThrow();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('FIRES onAuthInvalid for 401 AUTH_EXPIRED', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(401, { error: { code: 'AUTH_EXPIRED', message: 'go' } }),
      );
      const cb = vi.fn();
      const api = createFetcher({ baseUrl, onAuthInvalid: cb });
      await expect(api('/v1/thing')).rejects.toThrow();
      expect(cb).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire onAuthInvalid for 401 AUTH_MISSING (normal unauthed state)', async () => {
      // This is the regression test for the invalidation-loop bug:
      // AUTH_MISSING just means "no token sent" — clearing + invalidating
      // here triggers an infinite re-fetch loop. We must NOT call the
      // callback for this code.
      fetchSpy.mockResolvedValue(
        jsonResponse(401, { error: { code: 'AUTH_MISSING', message: 'sign in' } }),
      );
      const cb = vi.fn();
      const api = createFetcher({ baseUrl, onAuthInvalid: cb });
      await expect(api('/v1/thing')).rejects.toThrow();
      expect(cb).not.toHaveBeenCalled();
    });

    it('does NOT fire onAuthInvalid for non-401 errors', async () => {
      fetchSpy.mockResolvedValue(
        jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'nope' } }),
      );
      const cb = vi.fn();
      const api = createFetcher({ baseUrl, onAuthInvalid: cb });
      await expect(api('/v1/thing')).rejects.toThrow();
      expect(cb).not.toHaveBeenCalled();
    });
  });
});
