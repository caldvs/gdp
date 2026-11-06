import type { MiddlewareHandler } from 'hono';
import { createHash } from 'node:crypto';
import { AppError } from '../errors/AppError.js';
import { idempotencyStore } from '../storage/idempotencyStore.js';

// UUID v1-v8 — matches the openapi `format: uuid` declaration.
const KEY_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export const requireIdempotency = (): MiddlewareHandler => async (c, next) => {
  const key = c.req.header('idempotency-key');
  if (!key) {
    throw new AppError('INVALID_INPUT', 'Idempotency-Key header required');
  }
  if (!KEY_PATTERN.test(key)) {
    throw new AppError('INVALID_INPUT', 'Idempotency-Key has invalid format');
  }

  const userId = c.var.userId;
  if (!userId) {
    throw new AppError('AUTH_MISSING', 'Authenticated user required for idempotent endpoint');
  }

  const endpoint = `${c.req.method} ${c.req.routePath}`;
  const bodyText = await c.req.text();
  // Hash includes the actual path so the same key against two different
  // sessionIds (or any path-param value) produces distinct cache entries.
  const bodyHash = createHash('sha256')
    .update(c.req.path)
    .update('\n')
    .update(bodyText)
    .digest('hex');

  // Hold the key before running, so a double tap or a retry sent while
  // the first is still in flight can't run the handler a second time.
  const existing = await idempotencyStore.reserve(userId, endpoint, key, bodyHash);
  if (existing) {
    if (existing.bodyHash !== bodyHash) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different body');
    }
    if (!existing.response) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'A request with this key is still in progress');
    }
    return new Response(existing.response.body, {
      status: existing.response.status,
      headers: { 'content-type': existing.response.contentType, 'idempotency-replayed': 'true' },
    });
  }

  let stored = false;
  try {
    await next();
    const status = c.res.status;
    if (status >= 200 && status < 300) {
      const cloned = c.res.clone();
      const responseBody = await cloned.text();
      await idempotencyStore.put(userId, endpoint, key, {
        bodyHash,
        response: {
          status,
          body: responseBody,
          contentType: cloned.headers.get('content-type') ?? 'application/json',
        },
      });
      stored = true;
    }
  } finally {
    // Failed (an error response or a throw): free the key for a retry.
    if (!stored) await idempotencyStore.release(userId, endpoint, key);
  }
};
