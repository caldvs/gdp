import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/app.js';

describe('Docs routes', () => {
  const app = createApp();

  it('GET /docs returns the Redoc HTML page', async () => {
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('<redoc');
    expect(body).toContain('spec-url="/openapi.yaml"');
  });

  it('GET /openapi.yaml serves the spec', async () => {
    const res = await app.request('/openapi.yaml');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/yaml');
    const body = await res.text();
    expect(body).toMatch(/^openapi:\s*3\.1\.0/);
    expect(body).toContain('Group Dine Pay API');
  });

  it('does not require auth (unauthed callers see /docs)', async () => {
    const res = await app.request('/docs');
    expect(res.status).toBe(200);
  });
});
