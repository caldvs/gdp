import { describe, expect, it } from 'vitest';
import { checkResponse } from './contract.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('contract check', () => {
  it('passes a documented status with a matching body', async () => {
    expect(await checkResponse('GET', '/healthz', json(200, { status: 'ok' }))).toBeNull();
  });

  it('catches a body that does not match the schema', async () => {
    const v = await checkResponse('GET', '/healthz', json(200, { status: 42 }));
    expect(v).toMatch(/doesn't match/);
  });

  it('catches a status the operation does not list', async () => {
    const v = await checkResponse(
      'POST',
      '/v1/sessions/0193ab12-7c4d-7e00-9a1b-2c3d4e5f6a7b/close',
      json(418, { error: { code: 'INTERNAL_ERROR', message: 'x', requestId: 'r' } }),
    );
    expect(v).toMatch(/status 418 .* isn't listed/);
  });

  it('catches an error code missing from the spec', async () => {
    const v = await checkResponse(
      'GET',
      '/v1/me',
      json(401, { error: { code: 'NOPE', message: 'x', requestId: 'r' } }),
    );
    expect(v).toMatch(/error\/code/);
  });

  it('catches an undocumented path, prefers literal paths over templates', async () => {
    expect(await checkResponse('GET', '/v1/nowhere', json(200, {}))).toMatch(/no such path/);
    const v = await checkResponse(
      'POST',
      '/v1/sessions/by-code',
      json(404, { error: { code: 'NOT_FOUND', message: 'x', requestId: 'r' } }),
    );
    expect(v).toBeNull();
  });
});
