import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireIdempotency } from '../middleware/idempotency.js';
import { callerOf } from '../context/caller.js';
import { uploadService } from '../services/bills/uploadService.js';
import { parseService } from '../services/bills/parseService.js';
import { amendService } from '../services/bills/amendService.js';
import { imageService } from '../services/bills/imageService.js';
import { billStore } from '../storage/billStore.js';
import { sessionStore } from '../storage/sessionStore.js';
import { AppError } from '../errors/AppError.js';
import type { Bill } from '../types/bills.js';
import type { IdTokenVerifier } from '../services/auth.js';
import type { BillParser } from '../services/bills/parser.js';
import type { VenueResolver } from '../services/bills/venueResolver.js';
import { AmendBillRequestSchema, ParseRequestSchema, UploadRequestSchema } from '../types/bills.js';

async function loadBillForReader(billId: string, userId: string): Promise<Bill> {
  const bill = await billStore.getLatest(billId);
  if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');
  if (bill.creatorUserId === userId) return bill;
  // Session participants can read the bill they're pinned to: the live
  // session holds the bill lock; once it's closed (lock released) guests
  // still get in through their own sessions.
  const lock = await sessionStore.getBillLock(billId);
  if (lock) {
    const session = await sessionStore.get(lock.sessionId);
    if (session?.participants.some((p) => p.userId === userId)) {
      return bill;
    }
  }
  if (await sessionStore.userHasSessionForBill(userId, billId)) return bill;
  throw new AppError('BILL_NOT_FOUND', 'Bill not found');
}

export interface BillRoutesDeps {
  idTokenVerifier?: IdTokenVerifier;
  billParser: BillParser;
  venueResolver: VenueResolver;
}

export const buildBillRoutes = (deps: BillRoutesDeps): Hono => {
  const r = new Hono();

  r.post(
    '/uploads',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', UploadRequestSchema, (result, c) => {
      if (!result.success) {
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
          error.http as 400,
        );
      }
    }),
    async (c) => {
      const { userId } = callerOf(c);
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
      const { userId } = callerOf(c);
      const { uploadId } = c.req.valid('json');
      const bill = await parseService.parse({
        userId,
        uploadId,
        requestId: c.var.requestId,
        parser: deps.billParser,
        venueResolver: deps.venueResolver,
      });
      return c.json(bill);
    },
  );

  r.get('/:billId', requireAuth(deps.idTokenVerifier), async (c) => {
    const { userId } = callerOf(c);
    const billId = c.req.param('billId');
    const versionParam = c.req.query('version');

    if (versionParam) {
      // Older versions aren't pinned to a session lock, so reuse the latest
      // for authz then return the requested historical version.
      await loadBillForReader(billId, userId);
      const bill = await billStore.getVersion(billId, parseInt(versionParam, 10));
      if (!bill) throw new AppError('BILL_NOT_FOUND', 'Bill not found');
      return c.json(bill);
    }
    const bill = await loadBillForReader(billId, userId);
    return c.json(bill);
  });

  r.get('/:billId/image-url', requireAuth(deps.idTokenVerifier), async (c) => {
    const { userId } = callerOf(c);
    const billId = c.req.param('billId');
    const bill = await loadBillForReader(billId, userId);
    const uploadId = bill.parsedFrom.uploadId;
    if (!uploadId) {
      throw new AppError('NOT_FOUND', 'Original image is not available for this bill');
    }
    const result = await imageService.getImageUrl({
      creatorUserId: bill.creatorUserId,
      uploadId,
    });
    return c.json(result);
  });

  r.post(
    '/:billId/amend',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', AmendBillRequestSchema),
    async (c) => {
      const { userId } = callerOf(c);
      const billId = c.req.param('billId');
      const amendment = c.req.valid('json');
      const bill = await amendService.amend({ billId, userId, amendment });
      return c.json(bill);
    },
  );

  return r;
};
