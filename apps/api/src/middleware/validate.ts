import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { AppError } from '../errors/AppError.js';

/**
 * `zValidator('json', schema)` with the API's own error body: a bad body is
 * a 400 `INVALID_INPUT` with `requestId` and per-field errors, as the
 * contract says, rather than zod-validator's default shape.
 */
export const validJson = <T extends z.ZodType>(schema: T) =>
  zValidator('json', schema, (result, c) => {
    if (result.success) return;
    const error = new AppError('INVALID_INPUT', 'Validation failed', {
      fieldErrors: z.flattenError(result.error).fieldErrors,
    });
    return c.json(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId: c.var.requestId,
          details: error.details,
        },
      },
      400,
    );
  });
