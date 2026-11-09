import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { callerOf } from '../context/caller.js';
import { AppError } from '../errors/AppError.js';
import { listMySessions } from '../services/sessions/mySessions.js';
import { userStore } from '../storage/userStore.js';
import { z } from 'zod';
import { ProfilePatchSchema, SetPayoutAccountRequestSchema } from '../types/users.js';
import type { IdTokenVerifier } from '../services/auth.js';
import { mintSessionToken } from '../services/auth/sessionToken.js';

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

export const buildMeRoutes = (verifier?: IdTokenVerifier, jwtSecret?: Uint8Array): Hono => {
  const r = new Hono();

  r.get('/me', requireAuth(verifier), async (c) => {
    const { userId } = callerOf(c);
    // Profile fields (name/email/avatar) come from the verified token.
    // Stored fields (payoutAccount) come from our DDB User row, if present.
    const stored = await userStore.get(userId);
    // A phone account (#213) keeps its name and bill email on the user row.
    const email = c.var.userEmail || stored?.email;
    const name = c.var.userName || stored?.displayName;
    return c.json({
      userId,
      displayName: name || 'Unknown',
      // A new phone account (#213): the web app asks for a name first.
      ...(!name && !c.var.guestSessionId ? { needsName: true } : {}),
      ...(email ? { email } : {}),
      ...(c.var.userPicture ? { avatarUrl: c.var.userPicture } : {}),
      // A guest (#183): the web app shows them only this bill.
      ...(c.var.guestSessionId ? { guestSessionId: c.var.guestSessionId } : {}),
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

  // Sign out everywhere (#155): every session token this user holds, on
  // any device, stops working. The web app's Sign out calls it.
  r.post('/me/sign-out', requireAuth(verifier), async (c) => {
    const { userId } = callerOf(c);
    await userStore.bumpTokenVersion(userId);
    c.var.logger.info({ event: 'auth.signed_out_everywhere', userId }, 'Signed out everywhere');
    return c.json({ ok: true });
  });

  // #213: a phone account sets its name and the email its bill emails go
  // to. Answers with a fresh token, since the name travels in it.
  r.patch('/me', requireAuth(verifier), async (c) => {
    if (!jwtSecret) throw new AppError('INTERNAL_ERROR', 'Profile edits not configured');
    const caller = callerOf(c);
    if (c.var.guestSessionId) throw new AppError('AUTH_INVALID', 'Guests have no profile');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new AppError('INVALID_INPUT', 'Body must be valid JSON');
    }
    const parsed = ProfilePatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new AppError('INVALID_INPUT', 'Enter a name and a valid email', {
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    const user = await userStore.updateProfile({ userId: caller.userId, ...parsed.data });
    const displayName = user.displayName ?? '';
    const email = user.email ?? '';
    const token = await mintSessionToken(
      {
        userId: caller.userId,
        email,
        ...(displayName ? { name: displayName } : {}),
        tokenVersion: user.tokenVersion ?? 0,
      },
      jwtSecret,
    );
    return c.json({ token, user: { userId: caller.userId, displayName, email } });
  });

  r.get('/me/sessions', requireAuth(verifier), async (c) => {
    const { userId } = callerOf(c);
    const limitParam = c.req.query('limit');
    const parsed = limitParam ? parseInt(limitParam, 10) : DEFAULT_HISTORY_LIMIT;
    const limit =
      Number.isFinite(parsed) && parsed > 0
        ? Math.min(parsed, MAX_HISTORY_LIMIT)
        : DEFAULT_HISTORY_LIMIT;

    return c.json({ sessions: await listMySessions(userId, limit) });
  });

  return r;
};

export const meRoutes = buildMeRoutes();
