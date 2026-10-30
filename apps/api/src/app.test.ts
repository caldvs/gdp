import { describe, it, expect } from 'vitest';
import { app, createApp } from './app.js';

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

  describe('with an allow-list', () => {
    const locked = createApp({
      allowedOrigins: 'https://paymeback.dev,https://*-caldvs-projects.vercel.app',
    });
    const preflight = (origin: string) =>
      locked.request('/v1/me', {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
      });

    it('echoes a listed origin', async () => {
      const res = await preflight('https://paymeback.dev');
      expect(res.headers.get('access-control-allow-origin')).toBe('https://paymeback.dev');
      expect(res.headers.get('vary')?.toLowerCase()).toContain('origin');
    });

    it('echoes a preview URL that matches the wildcard', async () => {
      const o = 'https://web-nqib-abc123-caldvs-projects.vercel.app';
      expect((await preflight(o)).headers.get('access-control-allow-origin')).toBe(o);
    });

    it('sends no allow-origin header for anything else', async () => {
      const res = await preflight('https://evil.example');
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      const get = await locked.request('/healthz', { headers: { Origin: 'https://evil.example' } });
      expect(get.headers.get('access-control-allow-origin')).toBeNull();
    });
  });
});
