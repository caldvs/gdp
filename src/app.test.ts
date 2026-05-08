import { describe, it, expect } from 'vitest';
import { app } from './app.js';

describe('GET /healthz', () => {
  it('returns 200 with status ok', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
