import type { MiddlewareHandler } from 'hono';
import { AppError } from '../errors/AppError.js';
import type { IdTokenVerifier } from '../services/auth.js';

/**
 * What a guest's token may call (#183): their own session and what hangs
 * off it (claims, splits, payments, the bill it's pinned to), and /v1/me.
 * The routes still check they're at the table; this keeps a guest token
 * from reaching anything else (other bills, scanning, billing, history).
 */
export function guestMayCall(method: string, path: string, sessionId: string): boolean {
  if (path === '/v1/me') return method === 'GET';
  if (path === `/v1/sessions/${sessionId}` || path.startsWith(`/v1/sessions/${sessionId}/`))
    return true;
  if (/^\/v1\/bills\/[^/]+(\/image-url)?$/.test(path)) return method === 'GET';
  if (/^\/v1\/payments\/[^/]+$/.test(path)) return method === 'GET';
  if (/^\/v1\/payments\/[^/]+\/mark-paid$/.test(path)) return method === 'POST';
  return false;
}

export const requireAuth =
  (verifier?: IdTokenVerifier): MiddlewareHandler =>
  async (c, next) => {
    if (!verifier) {
      // No verifier wired in this app instance. Either app.ts didn't
      // configure one (e.g. SESSION_JWT_SECRET missing in dev) or this
      // is a degraded local boot. Refuse the request rather than letting
      // it through with no identity.
      throw new AppError('INTERNAL_ERROR', 'Auth verifier not configured');
    }
    const header = c.req.header('authorization');
    if (!header) {
      throw new AppError('AUTH_MISSING', 'Authorization header required');
    }
    if (!header.startsWith('Bearer ')) {
      throw new AppError('AUTH_INVALID', 'Authorization header must use Bearer scheme');
    }
    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new AppError('AUTH_INVALID', 'Bearer token is empty');
    }

    const identity = await verifier(token);
    c.set('userId', identity.userId);
    c.set('userEmail', identity.email);
    c.set('userName', identity.name);
    c.set('userPicture', identity.picture);
    if (identity.guestSessionId) {
      c.set('guestSessionId', identity.guestSessionId);
      if (!guestMayCall(c.req.method, c.req.path, identity.guestSessionId)) {
        // AUTH_MISSING, not AUTH_INVALID: the guest stays signed in to their bill.
        throw new AppError('AUTH_MISSING', 'Sign in to do that');
      }
    }

    await next();
  };
