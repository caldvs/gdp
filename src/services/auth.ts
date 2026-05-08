import { OAuth2Client } from 'google-auth-library';
import { env } from '../config/env.js';
import { AppError } from '../errors/AppError.js';

export interface VerifiedIdentity {
  userId: string;
  email?: string;
  name?: string;
}

export type IdTokenVerifier = (token: string) => Promise<VerifiedIdentity>;

const client = new OAuth2Client();

export const verifyGoogleIdToken: IdTokenVerifier = async (token) => {
  if (!env.GOOGLE_CLIENT_ID) {
    throw new AppError('INTERNAL_ERROR', 'GOOGLE_CLIENT_ID not configured');
  }

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken: token,
      audience: env.GOOGLE_CLIENT_ID,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown';
    if (msg.toLowerCase().includes('expired')) {
      throw new AppError('AUTH_EXPIRED', 'Token expired');
    }
    throw new AppError('AUTH_INVALID', 'Token verification failed');
  }

  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw new AppError('AUTH_INVALID', 'Token missing sub claim');
  }

  return {
    userId: payload.sub,
    email: payload.email,
    name: payload.name,
  };
};
