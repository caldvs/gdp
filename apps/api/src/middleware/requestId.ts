import type { MiddlewareHandler } from 'hono';
import { v7 as uuidv7 } from 'uuid';

export const requestId = (): MiddlewareHandler => async (c, next) => {
  const incoming = c.req.header('x-request-id');
  const id = incoming && /^[A-Za-z0-9-]{1,64}$/.test(incoming) ? incoming : uuidv7();
  c.set('requestId', id);
  c.header('X-Request-Id', id);
  await next();
};
