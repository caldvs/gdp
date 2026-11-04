import { Hono } from 'hono';
import { validJson } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { requireIdempotency } from '../middleware/idempotency.js';
import { callerOf } from '../context/caller.js';
import { sessionService } from '../services/sessions/sessionService.js';
import { paymentService } from '../services/payments/paymentService.js';
import {
  AddShareRequestSchema,
  SetShareWaysRequestSchema,
  ClaimsRequestSchema,
  CreateSessionRequestSchema,
  JoinByCodeRequestSchema,
  LockClaimsRequestSchema,
  SetReadyRequestSchema,
  UpdateSessionRequestSchema,
} from '../types/sessions.js';
import type { IdTokenVerifier } from '../services/auth.js';
import type { ReportService } from '../services/sessions/reportService.js';
import type { TableFeeService } from '../services/billing/tableFee.js';
import type { Session } from '../types/sessions.js';
import { baseLogger } from '../logging/logger.js';

export interface SessionRoutesDeps {
  idTokenVerifier?: IdTokenVerifier;
  /** Emails bill reports. Absent in tests that don't need it. */
  reports?: ReportService;
  /** Gates sharing on the fee, and refunds it when nobody joined. Absent when Stripe is off. */
  tableFees?: Pick<TableFeeService, 'refundIfNobodyJoined' | 'shareEntitlement'>;
}

export const buildSessionRoutes = (deps: SessionRoutesDeps): Hono => {
  const r = new Hono();

  // Closing or binning the bill always succeeds for the lead; a refund
  // that fails is logged for a manual one (the Refunds page's "ask us").
  const refundIfNobodyJoined = async (session: Session) => {
    if (!deps.tableFees) return;
    try {
      const outcome = await deps.tableFees.refundIfNobodyJoined(session);
      if (outcome === 'credit_returned') {
        baseLogger.info(
          { event: 'table_fee.credit_returned', sessionId: session.sessionId },
          'Credit returned: nobody joined',
        );
      }
      if (outcome === 'refunded') {
        baseLogger.info(
          { event: 'table_fee.refunded', sessionId: session.sessionId, billId: session.billId },
          'Table fee refunded: nobody joined',
        );
      }
    } catch (err) {
      baseLogger.error(
        {
          event: 'table_fee.refund_failed',
          sessionId: session.sessionId,
          billId: session.billId,
          err,
        },
        'Table fee refund failed',
      );
    }
  };

  r.post(
    '/',
    requireAuth(deps.idTokenVerifier),
    validJson(CreateSessionRequestSchema),
    async (c) => {
      const caller = callerOf(c);
      const body = c.req.valid('json');
      const session = await sessionService.create({
        caller,
        billId: body.billId,
        billVersion: body.billVersion,
        expectedDiners: body.expectedDiners,
      });
      return c.json(session, 201);
    },
  );

  r.post(
    '/by-code',
    requireAuth(deps.idTokenVerifier),
    validJson(JoinByCodeRequestSchema),
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

  r.patch(
    '/:sessionId',
    requireAuth(deps.idTokenVerifier),
    validJson(UpdateSessionRequestSchema),
    async (c) => {
      const caller = callerOf(c);
      const sessionId = c.req.param('sessionId');
      const { expectedDiners } = c.req.valid('json');
      const session = await sessionService.setExpectedDiners({ caller, sessionId, expectedDiners });
      return c.json(session);
    },
  );

  // The QR: needs the bill's paid fee, an exempt lead, or this month's
  // credit (402 TABLE_FEE_REQUIRED otherwise). Free when Stripe is off.
  r.post('/:sessionId/share', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const sessionId = c.req.param('sessionId');
    // Optional body: the Checkout Session just paid, so a late webhook
    // doesn't block the share (the fee is checked with Stripe directly).
    let checkoutSessionId: string | undefined;
    try {
      const text = await c.req.text();
      const body = text.trim() ? (JSON.parse(text) as { checkoutSessionId?: unknown }) : {};
      if (
        typeof body.checkoutSessionId === 'string' &&
        /^cs_[A-Za-z0-9_]+$/.test(body.checkoutSessionId)
      ) {
        checkoutSessionId = body.checkoutSessionId;
      }
    } catch {
      /* no body, or not JSON: nothing to check with Stripe */
    }
    const tableFees = deps.tableFees;
    const session = await sessionService.share({
      caller,
      sessionId,
      ...(tableFees
        ? {
            entitle: (s: Session) =>
              tableFees.shareEntitlement({
                caller,
                billId: s.billId,
                sessionId: s.sessionId,
                ...(checkoutSessionId ? { checkoutSessionId } : {}),
              }),
          }
        : {}),
    });
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
    validJson(ClaimsRequestSchema),
    async (c) => {
      const caller = callerOf(c);
      const sessionId = c.req.param('sessionId');
      const claims = c.req.valid('json');
      const session = await sessionService.setClaims({ caller, sessionId, claims });
      return c.json(session);
    },
  );

  r.post(
    '/:sessionId/shares',
    requireAuth(deps.idTokenVerifier),
    validJson(AddShareRequestSchema),
    async (c) => {
      const caller = callerOf(c);
      const sessionId = c.req.param('sessionId');
      const { itemId, ways } = c.req.valid('json');
      const session = await sessionService.addShare({ caller, sessionId, itemId, ways });
      return c.json(session);
    },
  );

  r.put(
    '/:sessionId/shares/:itemId',
    requireAuth(deps.idTokenVerifier),
    validJson(SetShareWaysRequestSchema),
    async (c) => {
      const caller = callerOf(c);
      const sessionId = c.req.param('sessionId');
      const itemId = c.req.param('itemId');
      const { ways } = c.req.valid('json');
      const session = await sessionService.setShareWays({ caller, sessionId, itemId, ways });
      return c.json(session);
    },
  );

  r.delete('/:sessionId/shares/:itemId', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const sessionId = c.req.param('sessionId');
    const itemId = c.req.param('itemId');
    const session = await sessionService.removeShare({ caller, sessionId, itemId });
    return c.json(session);
  });

  r.post(
    '/:sessionId/ready',
    requireAuth(deps.idTokenVerifier),
    validJson(SetReadyRequestSchema),
    async (c) => {
      const caller = callerOf(c);
      const sessionId = c.req.param('sessionId');
      const { ready } = c.req.valid('json');
      const session = await sessionService.setReady({ caller, sessionId, ready });
      return c.json(session);
    },
  );

  r.post(
    '/:sessionId/lock-claims',
    requireAuth(deps.idTokenVerifier),
    // Body is optional ({ force: true } to override the all-ready precondition).
    async (c) => {
      const caller = callerOf(c);
      const sessionId = c.req.param('sessionId');
      let body: unknown = {};
      try {
        const text = await c.req.text();
        if (text.trim().length > 0) body = JSON.parse(text);
      } catch {
        /* empty/invalid body — treat as no force */
      }
      const parsed = LockClaimsRequestSchema.safeParse(body);
      const force = parsed.success ? (parsed.data.force ?? false) : false;
      const session = await sessionService.lockClaims({ caller, sessionId, force });
      return c.json(session);
    },
  );

  r.post('/:sessionId/close', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const sessionId = c.req.param('sessionId');
    const reports = deps.reports;
    const session = await sessionService.close({
      caller,
      sessionId,
      ...(reports ? { onClosed: (id: string) => reports.emailEveryone(id) } : {}),
    });
    await refundIfNobodyJoined(session);
    return c.json(session);
  });

  // Email the caller their bill report: the lead's lists every diner,
  // a guest's only what they had. Works while the bill is open too.
  r.post('/:sessionId/report', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    if (!deps.reports) return c.json({ sent: false }, 503);
    await deps.reports.emailToCaller({
      sessionId: c.req.param('sessionId'),
      userId: caller.userId,
    });
    return c.json({ sent: true }, 202);
  });

  r.post('/:sessionId/abandon', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const sessionId = c.req.param('sessionId');
    const session = await sessionService.abandon({ caller, sessionId });
    await refundIfNobodyJoined(session);
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
        logger: c.var.logger,
      });
      return c.json({ payment: result.payment, instructions: result.instructions }, 201);
    },
  );

  return r;
};
