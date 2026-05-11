import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { callerOf } from '../context/caller.js';
import { AppError } from '../errors/AppError.js';
import { sessionStore } from '../storage/sessionStore.js';
import { userStore } from '../storage/userStore.js';
import { z } from 'zod';
import { SetPayoutAccountRequestSchema } from '../types/users.js';
import type { IdTokenVerifier } from '../services/auth.js';

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

export const buildMeRoutes = (verifier?: IdTokenVerifier): Hono => {
  const r = new Hono();

  r.get('/me', requireAuth(verifier), async (c) => {
    const { userId } = callerOf(c);
    // Profile fields (name/email/avatar) come from the verified token.
    // Stored fields (payoutAccount) come from our DDB User row, if present.
    const stored = await userStore.get(userId);
    return c.json({
      userId,
      displayName: c.var.userName ?? 'Unknown',
      ...(c.var.userEmail ? { email: c.var.userEmail } : {}),
      ...(c.var.userPicture ? { avatarUrl: c.var.userPicture } : {}),
      ...(stored?.payoutAccount ? { payoutAccount: stored.payoutAccount } : {}),
    });
  });

  // Deprecated per ADR-0002. Bank details are device-local; we no longer
  // persist them server-side. Still validates the body and echoes 200
  // for compatibility with clients on the old code path, and emits a
  // structured log line so we can track when traffic to this endpoint
  // drops to zero.
  r.put('/me/payout-account', requireAuth(verifier), async (c) => {
    const { userId } = callerOf(c);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError('INVALID_INPUT', 'Body must be valid JSON');
    }
    const parsed = SetPayoutAccountRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('INVALID_INPUT', 'Invalid payout account', {
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    c.var.logger.info(
      { event: 'payoutAccount.write.ignored', userId, userAgent: c.req.header('user-agent') },
      'deprecated payout-account write ignored',
    );
    return c.json({ payoutAccount: parsed.data });
  });

  r.get('/me/sessions', requireAuth(verifier), async (c) => {
    const { userId } = callerOf(c);
    const limitParam = c.req.query('limit');
    const parsed = limitParam ? parseInt(limitParam, 10) : DEFAULT_HISTORY_LIMIT;
    const limit =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, MAX_HISTORY_LIMIT)
        : DEFAULT_HISTORY_LIMIT;

    const summaries = await sessionStore.listForUser(userId, limit);
    return c.json({ sessions: summaries });
  });

  return r;
};

export const meRoutes = buildMeRoutes();
