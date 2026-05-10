import type { MiddlewareHandler } from 'hono';
import { AppError } from '../errors/AppError.js';
import { verifyGoogleIdToken, type IdTokenVerifier } from '../services/auth.js';

export const requireAuth =
  (verifier: IdTokenVerifier = verifyGoogleIdToken): MiddlewareHandler =>
  async (c, next) => {
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
