import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { requireAuth } from '../middleware/auth.js';
import { requireIdempotency } from '../middleware/idempotency.js';
import { callerOf } from '../context/caller.js';
import { sessionService } from '../services/sessions/sessionService.js';
import { paymentService } from '../services/payments/paymentService.js';
import {
  ClaimsRequestSchema,
  CreateSessionRequestSchema,
  JoinByCodeRequestSchema,
} from '../types/sessions.js';
import type { IdTokenVerifier } from '../services/auth.js';
import type { PaymentProvider } from '../services/payments/provider.js';

export interface SessionRoutesDeps {
  idTokenVerifier?: IdTokenVerifier;
  paymentProvider: PaymentProvider;
}

export const buildSessionRoutes = (deps: SessionRoutesDeps): Hono => {
  const r = new Hono();

  r.post(
    '/',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', CreateSessionRequestSchema),
    async (c) => {
      const caller = callerOf(c);
      const body = c.req.valid('json');
      const session = await sessionService.create({
        caller,
        billId: body.billId,
        billVersion: body.billVersion,
      });
      return c.json(session, 201);
    },
  );

  r.post(
    '/by-code',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', JoinByCodeRequestSchema),
    async (c) => {
      const { code } = c.req.valid('json');
      const result = await sessionService.resolveByCode({ code });
      return c.json(result);
    },
  );

  r.get('/:sessionId', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const sessionId = c.req.param('sessionId');
    const session = await sessionService.get({ caller, sessionId });
    return c.json(session);
  });

  r.post('/:sessionId/share', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const sessionId = c.req.param('sessionId');
    const session = await sessionService.share({ caller, sessionId });
    return c.json(session);
  });

  r.post('/:sessionId/join', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const sessionId = c.req.param('sessionId');
    const session = await sessionService.join({ caller, sessionId });
    return c.json(session);
  });

  r.post(
    '/:sessionId/claims',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', ClaimsRequestSchema),
    async (c) => {
      const caller = callerOf(c);
      const sessionId = c.req.param('sessionId');
      const claims = c.req.valid('json');
      const session = await sessionService.setClaims({ caller, sessionId, claims });
      return c.json(session);
    },
  );

  r.post('/:sessionId/lock-claims', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const sessionId = c.req.param('sessionId');
    const session = await sessionService.lockClaims({ caller, sessionId });
    return c.json(session);
  });

  r.post('/:sessionId/abandon', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const sessionId = c.req.param('sessionId');
    const session = await sessionService.abandon({ caller, sessionId });
    return c.json(session);
  });

  r.post(
    '/:sessionId/payments',
    requireAuth(deps.idTokenVerifier),
    requireIdempotency(),
    async (c) => {
      const caller = callerOf(c);
      const sessionId = c.req.param('sessionId');
      // requireIdempotency has already validated the header is present.
      const idempotencyKey = c.req.header('idempotency-key')!;
      const result = await paymentService.initiate({
        caller,
        sessionId,
        idempotencyKey,
        provider: deps.paymentProvider,
        logger: c.var.logger,
      });
      return c.json(
        { payment: result.payment, providerRedirectUrl: result.providerRedirectUrl },
        201,
      );
    },
  );

  return r;
};
