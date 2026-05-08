import { describe, it, expect } from 'vitest';
import { app } from './app.js';

describe('GET /healthz', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('CORS', () => {
  it('responds to OPTIONS preflight with permissive headers', async () => {
    const res = await app.request('/v1/me', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:8081',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('GET');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'idempotency-key',
    );
  });

  it('includes Access-Control-Allow-Origin on actual responses', async () => {
    const res = await app.request('/healthz', {
      headers: { Origin: 'http://localhost:8081' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('exposes x-request-id so the browser client can read it', async () => {
    const res = await app.request('/v1/me', {
      headers: { Origin: 'http://localhost:8081' },
    });
    expect(res.headers.get('access-control-expose-headers')?.toLowerCase()).toContain(
      'x-request-id',
    );
  });
});
