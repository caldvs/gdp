import { describe, it, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { idempotencyStore } from '../../src/storage/idempotencyStore.js';

describe('idempotencyStore', () => {
  it('returns null when key does not exist', async () => {
    const result = await idempotencyStore.get(`u-${uuidv7()}`, 'POST /test', uuidv7());
    expect(result).toBeNull();
  });

  it('stores and retrieves a record by (userId, endpoint, key)', async () => {
    const userId = `u-${uuidv7()}`;
    const endpoint = 'POST /v1/test';
    const key = uuidv7();

    await idempotencyStore.put(userId, endpoint, key, {
      bodyHash: 'abc123',
      response: { status: 201, body: '{"ok":true}', contentType: 'application/json' },
    });

    const fetched = await idempotencyStore.get(userId, endpoint, key);
    expect(fetched).not.toBeNull();
    expect(fetched?.bodyHash).toBe('abc123');
    expect(fetched?.response?.status).toBe(201);
    expect(fetched?.response?.body).toBe('{"ok":true}');
  });

  it('isolates by userId — same key for different users is independent', async () => {
    const endpoint = 'POST /v1/iso';
    const key = uuidv7();

    await idempotencyStore.put('user-a', endpoint, key, {
      bodyHash: 'A',
      response: { status: 200, body: 'a', contentType: 'text/plain' },
    });
    await idempotencyStore.put('user-b', endpoint, key, {
      bodyHash: 'B',
      response: { status: 200, body: 'b', contentType: 'text/plain' },
    });

    const a = await idempotencyStore.get('user-a', endpoint, key);
    const b = await idempotencyStore.get('user-b', endpoint, key);
    expect(a?.response?.body).toBe('a');
    expect(b?.response?.body).toBe('b');
  });

  it('reserve: the first request holds the key, a second sees it still running', async () => {
    const userId = `u-${uuidv7()}`;
    const key = uuidv7();
    expect(await idempotencyStore.reserve(userId, 'POST /v1/r', key, 'h')).toBeNull();
    expect(await idempotencyStore.reserve(userId, 'POST /v1/r', key, 'h')).toEqual({
      bodyHash: 'h',
    });
  });

  it('reserve: once finished, a second request gets the stored response', async () => {
    const userId = `u-${uuidv7()}`;
    const key = uuidv7();
    const response = { status: 201, body: '{}', contentType: 'application/json' };
    await idempotencyStore.reserve(userId, 'POST /v1/r', key, 'h');
    await idempotencyStore.put(userId, 'POST /v1/r', key, { bodyHash: 'h', response });
    expect(await idempotencyStore.reserve(userId, 'POST /v1/r', key, 'h')).toEqual({
      bodyHash: 'h',
      response,
    });
  });

  it('release frees a reservation but never a finished response', async () => {
    const userId = `u-${uuidv7()}`;
    const [open, done] = [uuidv7(), uuidv7()];
    const response = { status: 200, body: 'x', contentType: 'text/plain' };
    await idempotencyStore.reserve(userId, 'POST /v1/r', open, 'h');
    await idempotencyStore.release(userId, 'POST /v1/r', open);
    expect(await idempotencyStore.reserve(userId, 'POST /v1/r', open, 'h')).toBeNull();

    await idempotencyStore.put(userId, 'POST /v1/r', done, { bodyHash: 'h', response });
    await idempotencyStore.release(userId, 'POST /v1/r', done);
    expect((await idempotencyStore.get(userId, 'POST /v1/r', done))?.response).toEqual(response);
  });
});
