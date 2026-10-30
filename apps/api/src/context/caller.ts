import type { Context } from 'hono';
import { AppError } from '../errors/AppError.js';

export interface VerifiedCaller {
  userId: string;
  displayName: string;
  email?: string;
  /** Profile picture URL from the IdP. Optional. */
  avatarUrl?: string;
}

/**
 * Pull the verified caller out of the request context.
 * `requireAuth` middleware must have run upstream — this is a typed
 * accessor that narrows `c.var.userId` from `string | undefined` to
 * `string` in one place rather than every route.
 */
export function callerOf(c: Context): VerifiedCaller {
  const userId = c.var.userId;
  if (!userId) {
    throw new AppError('AUTH_MISSING', 'No verified user in context');
  }
  return {
    userId,
    displayName: c.var.userName ?? userId,
    ...(c.var.userEmail ? { email: c.var.userEmail } : {}),
    ...(c.var.userPicture ? { avatarUrl: c.var.userPicture } : {}),
  };
}
