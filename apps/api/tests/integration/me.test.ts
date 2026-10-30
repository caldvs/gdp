import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/app.js';
import { AppError } from '../../src/errors/AppError.js';
import type { IdTokenVerifier } from '../../src/services/auth.js';

const fakeVerifier: IdTokenVerifier = (token) => {
  if (token === 'good-token') {
    return Promise.resolve({
      userId: 'sub-123',
      email: 'alice@example.com',
      name: 'Alice',
      picture: 'https://lh3.googleusercontent.com/a/alice.jpg',
    });
  }
  if (token === 'good-token-no-pic') {
    return Promise.resolve({ userId: 'sub-456', email: 'bob@example.com', name: 'Bob' });
  }
  if (token === 'expired-token') return Promise.reject(new AppError('AUTH_EXPIRED', 'expired'));
  return Promise.reject(new AppError('AUTH_INVALID', 'invalid'));
};

describe('GET /v1/me', () => {
  const app = createApp({ idTokenVerifier: fakeVerifier });

  it('returns 401 AUTH_MISSING when no Authorization header', async () => {
    const res = await app.request('/v1/me');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_MISSING');
  });

  it('returns 401 AUTH_INVALID for non-Bearer scheme', async () => {
    const res = await app.request('/v1/me', { headers: { authorization: 'Basic abc' } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_INVALID');
  });

  it('returns 401 AUTH_INVALID for unverifiable token', async () => {
    const res = await app.request('/v1/me', { headers: { authorization: 'Bearer junk' } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_INVALID');
  });

  it('returns 401 AUTH_EXPIRED for expired token', async () => {
    const res = await app.request('/v1/me', {
      headers: { authorization: 'Bearer expired-token' },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_EXPIRED');
  });

  it('returns the verified user for a valid token (with avatar)', async () => {
    const res = await app.request('/v1/me', {
      headers: { authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: 'sub-123',
      displayName: 'Alice',
      email: 'alice@example.com',
      avatarUrl: 'https://lh3.googleusercontent.com/a/alice.jpg',
    });
  });

  it('omits avatarUrl when the token has no picture claim', async () => {
    const res = await app.request('/v1/me', {
      headers: { authorization: 'Bearer good-token-no-pic' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('avatarUrl');
    expect(body.userId).toBe('sub-456');
  });

  it('ignores any userId in headers — only the verified sub claim is trusted', async () => {
    const res = await app.request('/v1/me', {
      headers: {
        authorization: 'Bearer good-token',
        'x-user-id': 'sub-evil',
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string };
    expect(body.userId).toBe('sub-123');
  });
});
