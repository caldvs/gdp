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

  const cached = await idempotencyStore.get(userId, endpoint, key);
  if (cached) {
    if (cached.bodyHash !== bodyHash) {
      throw new AppError('IDEMPOTENCY_CONFLICT', 'Idempotency key reused with a different body');
    }
    return new Response(cached.response.body, {
      status: cached.response.status,
      headers: { 'content-type': cached.response.contentType, 'idempotency-replayed': 'true' },
    });
  }

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
  }
};
