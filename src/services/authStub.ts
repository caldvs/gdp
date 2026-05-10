import type { IdTokenVerifier } from './auth.js';
import { AppError } from '../errors/AppError.js';

/**
 * STRICTLY FOR LOCAL DEVELOPMENT — never wire into a deployed environment.
 *
 * Accepts tokens of the form `dev:<userId>` and trusts them. Any other
 * token shape rejects with AUTH_INVALID. Used by the local server when
 * AUTH_BYPASS_LOCAL=true is set, so multi-user e2e scripts can act as
 * arbitrary identities without provisioning real Google accounts.
 *
 * Guards in src/local.ts refuse to start with this enabled when
 * NODE_ENV === 'production' or when the local DDB endpoint isn't set.
 */
export const localStubVerifier: IdTokenVerifier = (token) => {
  if (!token.startsWith('dev:')) {
    return Promise.reject(new AppError('AUTH_INVALID', 'expected dev:<userId> (auth-bypass mode)'));
  }
  const userId = token.slice('dev:'.length);
  if (!userId) {
    return Promise.reject(new AppError('AUTH_INVALID', 'empty userId after dev:'));
  }
  return Promise.resolve({
    userId,
    email: `${userId}@dev.local`,
    name: userId,
    // DiceBear renders a deterministic illustrated PNG keyed by the userId.
    // Real images render fine in the small avatar slot on the session screen;
    // initials are awkward and crowded at that size. Personas style is
    // friendly-cartoon and PNG (RN Image can't render SVG natively).
    picture: `https://api.dicebear.com/7.x/personas/png?seed=${encodeURIComponent(userId)}&size=128`,
  });
};
