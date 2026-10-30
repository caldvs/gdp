import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/app.js';

describe('GET /healthz', () => {
  it('returns 200 with status ok and a request id', async () => {
    const app = createApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^[A-Za-z0-9-]+$/);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('returns 200 with checks ok against DDB Local + LocalStack', async () => {
    const app = createApp();
    const res = await app.request('/readyz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; checks: { ddb: string; s3: string } };
    expect(body.status).toBe('ok');
    expect(body.checks).toEqual({ ddb: 'ok', s3: 'ok' });
  });
});
