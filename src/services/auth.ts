import { AppError } from '../errors/AppError.js';
import { verifySessionToken } from './auth/sessionToken.js';

export interface VerifiedIdentity {
  userId: string;
  email?: string;
  name?: string;
  /** Profile photo URL. Reserved for future use; OTP flow doesn't capture one. */
  picture?: string;
}

export type IdTokenVerifier = (token: string) => Promise<VerifiedIdentity>;

/**
 * Verify a session JWT minted by the email-OTP flow.
 *
 * The verifier is intentionally simple — all the auth work happens at
 * /v1/auth/email/verify, which mints the token after a successful OTP.
 * Every subsequent request just decodes the JWT here, validates the
 * signature + expiry, and trusts the embedded claims.
 */
export const createSessionTokenVerifier =
  (secret: Uint8Array): IdTokenVerifier =>
  async (token) => {
    if (!token) throw new AppError('AUTH_INVALID', 'Empty token');
    const claims = await verifySessionToken(token, secret);
    return {
      userId: claims.userId,
      email: claims.email,
      ...(claims.name ? { name: claims.name } : {}),
    };
  };
