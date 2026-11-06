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
  GuestJoinRequestSchema,
  JoinByCodeRequestSchema,
  LockClaimsRequestSchema,
  SetPayoutCheckRequestSchema,
  SetReadyRequestSchema,
  UpdateSessionRequestSchema,
} from '../types/sessions.js';
import type { IdTokenVerifier } from '../services/auth.js';
import type { ReportService } from '../services/sessions/reportService.js';
import type { TableFeeService } from '../services/billing/tableFee.js';
import type { Session } from '../types/sessions.js';
import { baseLogger } from '../logging/logger.js';
import { AppError } from '../errors/AppError.js';
import { countInWindow } from '../storage/rateCounter.js';
import { mintSessionToken } from '../services/auth/sessionToken.js';
import { sourceIpOf } from './auth.js';

// Looking up join codes (#151): 30 tries per user per 10 minutes, so
// guessing six-character codes is slow. Plenty for mistyping a few.
const CODE_LOOKUPS_PER_WINDOW = 30;
const CODE_LOOKUP_WINDOW_SECONDS = 10 * 60;

// Guests joining with a name (#183): per IP address, so one phone can't
// fill a table with made-up people, and a cap per table.
const GUEST_JOINS_PER_IP_HOUR = 20;
const GUEST_JOINS_PER_SESSION_HOUR = 60;
const PREVIEWS_PER_IP_WINDOW = 60;

export interface SessionRoutesDeps {
  idTokenVerifier?: IdTokenVerifier;
  /** Signs guests' session tokens (#183). Absent: guests can't join without signing in. */
  jwtSecret?: Uint8Array;
  /** Emails bill reports. Absent in tests that don't need it. */
  reports?: ReportService;
  /** Gates sharing on the fee, and refunds it when nobody joined. Absent when Stripe is off. */
  tableFees?: Pick<TableFeeService, 'refundIfNobodyJoined' | 'shareEntitlement' | 'takeFromHold'>;
}

export const buildSessionRoutes = (deps: SessionRoutesDeps): Hono => {
  const r = new Hono();

  // Closing or binning the bill always succeeds for the lead; a Stripe
  // call that fails is logged, and the next close (or the daily sweep,
  // #168) tries again. Nobody joined: the hold is released (or an old fee
  // refunded) and a credit handed back. Guests joined: their part of the
  // platform fee is taken from the hold at close; a binned bill takes none.
  const settleFee = async (session: Session, binned: boolean) => {
    if (!deps.tableFees) return;
    try {
      const outcome = await deps.tableFees.refundIfNobodyJoined(session);
      if (outcome === 'guests_joined') {
        const owed = binned ? 0 : await sessionService.guestsFeePence(session.sessionId);
        const taken = await deps.tableFees.takeFromHold(session, owed);
        if (taken !== 'no_hold' && taken !== 'already_settled') {
          baseLogger.info(
            {
              event: `table_fee.${taken}`,
              sessionId: session.sessionId,
              billId: session.billId,
              guestsFeePence: owed,
            },
            'Hold settled at close',
          );
        }
      }
      if (outcome === 'credit_returned') {
        baseLogger.info(
          { event: 'table_fee.credit_returned', sessionId: session.sessionId },
          'Credit returned: nobody joined',
        );
      }
      if (outcome === 'released') {
        baseLogger.info(
          { event: 'table_fee.released', sessionId: session.sessionId, billId: session.billId },
          'Hold released: nobody joined',
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

  // The QR's landing page (#183): no sign-in, rate-limited per IP.
  r.post('/preview', validJson(JoinByCodeRequestSchema), async (c) => {
    const { code } = c.req.valid('json');
    const ip = sourceIpOf(c.env) ?? 'unknown';
    const allowed = await countInWindow(
      `CODERATE#ip:${ip}`,
      CODE_LOOKUP_WINDOW_SECONDS,
      PREVIEWS_PER_IP_WINDOW,
    );
    if (!allowed.ok) {
      throw new AppError('RATE_LIMITED', 'Too many tries. Wait a few minutes.', {
        retryAfterSeconds: allowed.retryAfterSeconds,
      });
    }
    return c.json(await sessionService.preview({ code }));
  });

  // Guests join with just a name, no account (#183). The token they get
  // works for this one session (see guestMayCall).
  r.post('/guest-join', validJson(GuestJoinRequestSchema), async (c) => {
    if (!deps.jwtSecret) throw new AppError('INTERNAL_ERROR', 'Guest join not configured');
    const { code, name } = c.req.valid('json');
    const ip = sourceIpOf(c.env) ?? 'unknown';
    const perIp = await countInWindow(`GUESTRATE#ip:${ip}`, 60 * 60, GUEST_JOINS_PER_IP_HOUR);
    if (!perIp.ok) {
      throw new AppError('RATE_LIMITED', 'Too many joins from here. Wait a while.', {
        retryAfterSeconds: perIp.retryAfterSeconds,
      });
    }
    const { sessionId } = await sessionService.resolveByCode({ code });
    const perTable = await countInWindow(
      `GUESTRATE#session:${sessionId}`,
      60 * 60,
      GUEST_JOINS_PER_SESSION_HOUR,
    );
    if (!perTable.ok) {
      throw new AppError('RATE_LIMITED', 'This table is full for now.', {
        retryAfterSeconds: perTable.retryAfterSeconds,
      });
    }
    const { userId, session } = await sessionService.joinAsGuest({ code, name });
    const token = await mintSessionToken(
      { userId, email: '', name, guestSessionId: sessionId },
      deps.jwtSecret,
    );
    baseLogger.info({ event: 'session.guest_joined', sessionId, userId }, 'Guest joined');
    return c.json({ token, session }, 201);
  });

  r.post(
    '/by-code',
    requireAuth(deps.idTokenVerifier),
    validJson(JoinByCodeRequestSchema),
    async (c) => {
      const { code } = c.req.valid('json');
      const { userId } = callerOf(c);
      const allowed = await countInWindow(
        `CODERATE#user:${userId}`,
        CODE_LOOKUP_WINDOW_SECONDS,
        CODE_LOOKUPS_PER_WINDOW,
      );
      if (!allowed.ok) {
        throw new AppError('RATE_LIMITED', 'Too many codes tried. Wait a few minutes.', {
          retryAfterSeconds: allowed.retryAfterSeconds,
        });
      }
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

  // #216: the lead opens payments early; they open by themselves once every line is claimed.
  r.post('/:sessionId/open-payments', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const sessionId = c.req.param('sessionId');
    const session = await sessionService.openPayments({ caller, sessionId });
    return c.json(session);
  });

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

  r.put(
    '/:sessionId/payout-check',
    requireAuth(deps.idTokenVerifier),
    validJson(SetPayoutCheckRequestSchema),
    async (c) => {
      const caller = callerOf(c);
      const sessionId = c.req.param('sessionId');
      const { payoutCheck } = c.req.valid('json');
      const session = await sessionService.setPayoutCheck({ caller, sessionId, payoutCheck });
      return c.json(session);
    },
  );

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
      const { itemId, ways, units } = c.req.valid('json');
      const session = await sessionService.addShare({ caller, sessionId, itemId, ways, units });
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
    await settleFee(session, false);
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
    await settleFee(session, true);
    return c.json(session);
  });

  // The lead saw the money land: everything this guest owes is received.
  r.post(
    '/:sessionId/participants/:userId/received',
    requireAuth(deps.idTokenVerifier),
    async (c) => {
      const caller = callerOf(c);
      const sessionId = c.req.param('sessionId');
      await paymentService.markReceived({
        caller,
        sessionId,
        userId: c.req.param('userId'),
        logger: c.var.logger,
      });
      return c.json(await sessionService.get({ caller, sessionId }));
    },
  );

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
