import { createHash, randomInt } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../errors/AppError.js';
import { otpStore } from '../../storage/otpStore.js';
import { authIdentityStore } from '../../storage/authIdentityStore.js';
import { userStore } from '../../storage/userStore.js';
import { mintSessionToken } from './sessionToken.js';
import type { EmailSender } from '../email/sender.js';
import type { Logger } from '../../logging/logger.js';

const CODE_DIGITS = 6;

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

const isValidEmail = (s: string): boolean =>
  // Pragmatic check — RFC 5321 allows wilder things than this, but the
  // 99.9% case is "looks-like-email", and stricter validation just makes
  // legitimate users miserable.
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

export interface EmailOtpServiceDeps {
  emailSender: EmailSender;
  jwtSecret: Uint8Array;
  logger?: Logger;
  /** Override for tests. */
  generateCode?: () => string;
}

export interface StartOtpInput {
  email: string;
}

export interface VerifyOtpInput {
  email: string;
  code: string;
}

export interface VerifyOtpResult {
  token: string;
  user: {
    userId: string;
    email: string;
    displayName: string;
  };
}

export const createEmailOtpService = (deps: EmailOtpServiceDeps) => ({
  /**
   * Generate an OTP, store the hash, and email the code. Returns
   * regardless of whether the email is known — the response is uniform
   * to prevent enumeration. Throws only on infrastructure failures.
   */
  async start(input: StartOtpInput): Promise<void> {
    if (!isValidEmail(input.email)) {
      // Validation failure IS visible to callers — we trade a slight
      // signal ("server confirms this looks malformed") for client-side
      // form validation parity.
      throw new AppError('INVALID_INPUT', 'Email is not in a valid shape');
    }
    const email = input.email.trim();
    const code = (deps.generateCode ?? defaultCode)();
    const codeHash = sha256(code);

    await otpStore.put(email, codeHash);

    await deps.emailSender.send({
      to: email,
      subject: 'Your Group Dine Pay sign-in code',
      category: 'otp',
      body: {
        text: `Your sign-in code: ${code}\n\nThis code expires in ${otpStore.OTP_TTL_SECONDS / 60} minutes. If you didn't request it, ignore this email.`,
        html: `<p>Your sign-in code:</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px;">${code}</p><p>This code expires in ${otpStore.OTP_TTL_SECONDS / 60} minutes. If you didn't request it, ignore this email.</p>`,
      },
    });

    deps.logger?.info({ event: 'otp.start', email }, 'OTP issued');
  },

  /**
   * Verify the OTP. On success: look up (or create) the userId for this
   * email, persist the user row if new, and mint a session JWT. On
   * failure: AppError('AUTH_INVALID') uniformly so the caller can't
   * distinguish "wrong code", "expired", or "no OTP for this email".
   */
  async verify(input: VerifyOtpInput): Promise<VerifyOtpResult> {
    if (!isValidEmail(input.email) || !/^[0-9]{6}$/.test(input.code)) {
      throw new AppError('AUTH_INVALID', 'Invalid email or code');
    }
    const email = input.email.trim();
    const codeHash = sha256(input.code);

    const record = await otpStore.get(email);
    if (!record || record.codeHash !== codeHash) {
      // Increment the attempt counter even on a wrong code so a brute-
      // force attempt against a known email gets locked out at 5 tries.
      // tryIncrementAttempt returns null when the row's gone or capped
      // — same response either way, no info leak.
      await otpStore.tryIncrementAttempt(email).catch(() => null);
      throw new AppError('AUTH_INVALID', 'Invalid email or code');
    }

    // Code matched; consume the OTP so it can't be reused.
    await otpStore.invalidate(email);
    const result = await signInByEmail(email, deps.jwtSecret);
    deps.logger?.info(
      { event: 'otp.verify.ok', userId: result.user.userId, email },
      'OTP verified',
    );
    return result;
  },

  /**
   * LOCAL DEVELOPMENT ONLY — sign in by email with no code. Same account
   * resolution as `verify`: a known email gets its existing user (and so
   * its bills and sessions); a new email gets a new user. Only reachable
   * when the local server registers the dev route (see src/local.ts).
   */
  async devSignIn(input: { email: string }): Promise<VerifyOtpResult> {
    if (!isValidEmail(input.email)) {
      throw new AppError('INVALID_INPUT', 'Email is not in a valid shape');
    }
    const email = input.email.trim().toLowerCase();
    const result = await signInByEmail(email, deps.jwtSecret);
    deps.logger?.warn(
      { event: 'auth.dev_sign_in', userId: result.user.userId, email },
      'Dev sign-in (no code)',
    );
    return result;
  },
});

/** Look up (or create) the user for this email and mint a session JWT. */
async function signInByEmail(email: string, jwtSecret: Uint8Array): Promise<VerifyOtpResult> {
  const existing = await authIdentityStore.getByEmail(email);
  let userId: string;
  let displayName: string;
  if (existing) {
    userId = existing.userId;
    const user = await userStore.get(userId);
    displayName = user?.displayName ?? defaultDisplayName(email);
  } else {
    userId = uuidv7();
    displayName = defaultDisplayName(email);
    const now = new Date().toISOString();
    await authIdentityStore.putByEmail({ email, userId, createdAt: now });
    await userStore.putProfile({ userId, email, displayName });
  }
  const token = await mintSessionToken({ userId, email, name: displayName }, jwtSecret);
  return { token, user: { userId, email, displayName } };
}

const defaultCode = (): string => {
  // randomInt is uniformly distributed in [0, 10**CODE_DIGITS).
  const n = randomInt(0, 10 ** CODE_DIGITS);
  return n.toString().padStart(CODE_DIGITS, '0');
};

const defaultDisplayName = (email: string): string => {
  // Local-part of the email, with `.`/`_`/`+suffix` stripped. Good
  // enough first-pass guess at the user's name; they can edit later.
  const local = email.split('@')[0] ?? 'user';
  return local.split('+')[0]!.replace(/[._]+/g, ' ').trim() || 'user';
};
