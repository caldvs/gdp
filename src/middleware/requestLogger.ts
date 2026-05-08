import type { MiddlewareHandler } from 'hono';
import { baseLogger } from '../logging/logger.js';

export const requestLogger = (): MiddlewareHandler => async (c, next) => {
  const start = Date.now();
  const log = baseLogger.child({
    requestId: c.var.requestId,
    method: c.req.method,
    path: c.req.path,
  });
  c.set('logger', log);

  await next();

  log.info({ status: c.res.status, latencyMs: Date.now() - start }, 'request');
};
