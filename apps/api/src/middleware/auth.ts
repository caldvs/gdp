import type { MiddlewareHandler } from 'hono';
import { AppError } from '../errors/AppError.js';
import type { IdTokenVerifier } from '../services/auth.js';

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

    await next();
  };
