import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireIdempotency } from '../middleware/idempotency.js';
import { uploadService } from '../services/bills/uploadService.js';
import { parseService } from '../services/bills/parseService.js';
import { amendService } from '../services/bills/amendService.js';
import { billStore } from '../storage/billStore.js';
import { AppError } from '../errors/AppError.js';
import type { IdTokenVerifier } from '../services/auth.js';
import type { BillParser } from '../services/bills/parser.js';
import { AmendBillRequestSchema, ParseRequestSchema, UploadRequestSchema } from '../types/bills.js';

export interface BillRoutesDeps {
  idTokenVerifier?: IdTokenVerifier;
  billParser: BillParser;
}

export const buildBillRoutes = (deps: BillRoutesDeps): Hono => {
  const r = new Hono();

  r.post(
    '/uploads',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', UploadRequestSchema, (result, c) => {
      if (!result.success) {
        const error = new AppError('INVALID_INPUT', 'Validation failed', {
          fieldErrors: result.error.flatten().fieldErrors,
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
          error.http as 400,
        );
      }
    }),
    async (c) => {
      const userId = c.var.userId;
      if (!userId) throw new AppError('AUTH_MISSING', 'No verified user');
      const body = c.req.valid('json');
      const result = await uploadService.requestUpload({ ...body, userId });
      return c.json(result);
    },
  );

  r.post(
    '/parse',
    requireAuth(deps.idTokenVerifier),
    requireIdempotency(),
    zValidator('json', ParseRequestSchema),
    async (c) => {
      const userId = c.var.userId;
      if (!userId) throw new AppError('AUTH_MISSING', 'No verified user');
      const { uploadId } = c.req.valid('json');
      const bill = await parseService.parse({
        userId,
        uploadId,
        requestId: c.var.requestId,
        parser: deps.billParser,
      });
      return c.json(bill);
    },
  );

  r.get('/:billId', requireAuth(deps.idTokenVerifier), async (c) => {
    const billId = c.req.param('billId');
    const versionParam = c.req.query('version');

    const bill = versionParam
      ? await billStore.getVersion(billId, parseInt(versionParam, 10))
      : await billStore.getLatest(billId);

    if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');
    return c.json(bill);
  });

  r.post(
    '/:billId/amend',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', AmendBillRequestSchema),
    async (c) => {
      const userId = c.var.userId;
      if (!userId) throw new AppError('AUTH_MISSING', 'No verified user');
      const billId = c.req.param('billId');
      const amendment = c.req.valid('json');
      const bill = await amendService.amend({ billId, userId, amendment });
      return c.json(bill);
    },
  );

  return r;
};
