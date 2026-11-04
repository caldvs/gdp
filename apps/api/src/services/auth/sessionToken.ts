import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { AppError } from '../../errors/AppError.js';

const ISSUER = 'gdp-backend';
const AUDIENCE = 'gdp-mobile';
const DEFAULT_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface SessionTokenClaims {
  userId: string;
  email: string;
  /** Display name, embedded so the verifier doesn't need a DB hit. */
  name?: string;
  /** The user's token version when minted (#155); signing out everywhere bumps it. */
  tokenVersion?: number;
  /**
   * A guest's token (#183): they joined one bill with just a name, and the
   * token works for that session only.
   */
  guestSessionId?: string;
}

/**
 * Mint a signed session token (HS256). The token carries the verified
 * caller's identity for ~30 days. Embedding email + name avoids a per-
 * request DB lookup at the cost of staleness on profile updates —
 * acceptable for v0.
 */
export async function mintSessionToken(
  claims: SessionTokenClaims,
  secret: Uint8Array,
  expirySeconds: number = DEFAULT_EXPIRY_SECONDS,
): Promise<string> {
  return new SignJWT({
    email: claims.email,
    ...(claims.name ? { name: claims.name } : {}),
    tv: claims.tokenVersion ?? 0,
    ...(claims.guestSessionId ? { gsid: claims.guestSessionId } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expirySeconds)
    .sign(secret);
}

export interface VerifiedSessionToken {
  userId: string;
  email: string;
  name?: string;
  /** 0 for tokens minted before versions existed. */
  tokenVersion: number;
  /** Set on a guest's token: the one session it works for (#183). */
  guestSessionId?: string;
}

/**
 * Verify a session token. Throws AUTH_EXPIRED / AUTH_INVALID via AppError
 * so the existing auth middleware reports the standard error envelope.
 */
export async function verifySessionToken(
  token: string,
  secret: Uint8Array,
): Promise<VerifiedSessionToken> {
  let result: {
    payload: { sub?: string; email?: unknown; name?: unknown; tv?: unknown; gsid?: unknown };
  };
  try {
    result = await jwtVerify(token, secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new AppError('AUTH_EXPIRED', 'Token expired');
    }
    throw new AppError('AUTH_INVALID', 'Token verification failed');
  }

  const { sub, email, name, tv, gsid } = result.payload;
  if (!sub || typeof email !== 'string') {
    throw new AppError('AUTH_INVALID', 'Token missing required claims');
  }
  return {
    userId: sub,
    email,
    ...(typeof name === 'string' ? { name } : {}),
    tokenVersion: typeof tv === 'number' ? tv : 0,
    ...(typeof gsid === 'string' ? { guestSessionId: gsid } : {}),
  };
}
