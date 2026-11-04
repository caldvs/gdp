import { AppError } from '../errors/AppError.js';
import { verifySessionToken } from './auth/sessionToken.js';
import { userStore } from '../storage/userStore.js';

export interface VerifiedIdentity {
  userId: string;
  email?: string;
  name?: string;
  /** Profile photo URL. Reserved for future use; OTP flow doesn't capture one. */
  picture?: string;
  /** A guest (#183): the one session their token works for. */
  guestSessionId?: string;
}

export type IdTokenVerifier = (token: string) => Promise<VerifiedIdentity>;

/**
 * Verify a session JWT minted by the email sign-in code flow.
 *
 * The verifier is intentionally simple — all the auth work happens at
 * /v1/auth/email/verify, which mints it once the emailed code is entered.
 * Every subsequent request decodes the JWT here, validates the signature
 * and expiry, and checks its token version against the user row's (one
 * GetItem), so signing out everywhere ends every older session (#155).
 */
export const createSessionTokenVerifier =
  (
    secret: Uint8Array,
    currentTokenVersion: (userId: string) => Promise<number> = (id) =>
      userStore.getTokenVersion(id),
  ): IdTokenVerifier =>
  async (token) => {
    if (!token) throw new AppError('AUTH_INVALID', 'Empty token');
    const claims = await verifySessionToken(token, secret);
    if (claims.tokenVersion < (await currentTokenVersion(claims.userId))) {
      throw new AppError('AUTH_INVALID', 'Signed out');
    }
    return {
      userId: claims.userId,
      email: claims.email,
      ...(claims.name ? { name: claims.name } : {}),
      ...(claims.guestSessionId ? { guestSessionId: claims.guestSessionId } : {}),
    };
  };
