import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { callerOf } from '../context/caller.js';
import { sessionStore } from '../storage/sessionStore.js';
import type { IdTokenVerifier } from '../services/auth.js';

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;

export const buildMeRoutes = (verifier?: IdTokenVerifier): Hono => {
  const r = new Hono();

  r.get('/me', requireAuth(verifier), (c) => {
    return c.json({
      userId: c.var.userId,
      displayName: c.var.userName ?? 'Unknown',
      ...(c.var.userEmail ? { email: c.var.userEmail } : {}),
      ...(c.var.userPicture ? { avatarUrl: c.var.userPicture } : {}),
    });
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
