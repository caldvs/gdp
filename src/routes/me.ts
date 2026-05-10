import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import type { IdTokenVerifier } from '../services/auth.js';

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

  return r;
};

export const meRoutes = buildMeRoutes();
