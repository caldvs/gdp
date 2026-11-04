import { randomBytes } from 'node:crypto';

/**
 * The join token in a session's QR (#182). Bills are joined only by
 * scanning the QR, never by typing, so the token is 128 random bits
 * (22 base64url characters) and can't be guessed.
 */
export const generateJoinCode = (): string => randomBytes(16).toString('base64url');

/** Six letters: the typed codes sessions had before #182. Still resolved for sessions opened before it. */
export const LEGACY_JOIN_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
export const JOIN_TOKEN = /^[A-Za-z0-9_-]{22}$/;
export const JOIN_CODE = /^(?:[A-HJ-NP-Z2-9]{6}|[A-Za-z0-9_-]{22})$/;

export const isJoinCode = (s: string): boolean => JOIN_CODE.test(s);
