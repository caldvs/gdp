import type { ErrorHandler } from 'hono';
import { AppError } from '../errors/AppError.js';
import { isProd } from '../config/env.js';

export const errorHandler: ErrorHandler = (err, c) => {
  const log = c.var.logger;
  const requestId = c.var.requestId ?? 'unknown';

  if (err instanceof AppError) {
    log?.warn({ err, code: err.code, details: err.details }, 'app error');
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
          requestId,
          ...(err.details && !isProd ? { details: err.details } : {}),
        },
      },
      err.http as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502,
    );
  }

  log?.error({ err }, 'unhandled error');
  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An internal error occurred',
        requestId,
      },
    },
    500,
  );
};
