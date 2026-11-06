import { createHash, randomBytes, randomInt } from 'node:crypto';
import { uuidv7 } from '../../lib/uuid.js';
import { AppError } from '../../errors/AppError.js';
import { SignInRateLimited, signInCodeStore } from '../../storage/signInCodeStore.js';
import { authIdentityStore } from '../../storage/authIdentityStore.js';
import { userStore } from '../../storage/userStore.js';
import { mintSessionToken } from './sessionToken.js';
import { rateKeyForEmail } from './rateKey.js';
import { emailHash } from '../../logging/emailHash.js';
import { isTestAccountEmail, TEST_ACCOUNT_DOMAIN } from './testAccounts.js';
import type { EmailSender } from '../email/sender.js';
import type { Logger } from '../../logging/logger.js';

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');
const secret = (bytes: number): string => randomBytes(bytes).toString('base64url');

const isValidEmail = (s: string): boolean =>
  // Pragmatic check — RFC 5321 allows wilder things than this, but the
  // 99.9% case is "looks-like-email", and stricter validation just makes
  // legitimate users miserable.
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * The asking tab's requestId is `<id>.<secret>`: the id finds the row, the
 * secret (only its hash is stored) proves the holder got it from
 * /email/start, so only that tab can enter the code.
 */
const REQUEST_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const parseRequestId = (raw: string): { id: string; hash: string } | null => {
  const m = REQUEST_RE.exec(raw);
  return m ? { id: m[1]!, hash: sha256(m[2]!) } : null;
};
/** The code's hash, salted with the request's id so equal codes don't hash alike. */
const codeHash = (id: string, code: string): string => sha256(`${id}:${code}`);

const RATE_LIMIT_MESSAGES: Record<SignInRateLimited['reason'], string> = {
  'too-soon': 'We’ve just sent a code. Check your email, or try again in a moment.',
  'too-many': 'Too many codes for this address. Wait a few minutes and try again.',
  ip: 'Too many sign-in codes from here. Try again later.',
  global: 'Sign-in is busy. Try again in a few minutes.',
};

export interface EmailSignInServiceDeps {
  emailSender: EmailSender;
  jwtSecret: Uint8Array;
  logger?: Logger;
  /** Sign in with just the email, no code (TABLE_FEE_EXEMPT_EMAILS). */
  exemptEmails?: ReadonlySet<string>;
}

export interface SignInResult {
  token: string;
  user: {
    userId: string;
    email: string;
    displayName: string;
  };
}

export type CodeEntryResult =
  | ({ status: 'signedIn' } & SignInResult)
  | { status: 'wrong'; attemptsLeft: number }
  | { status: 'expired' };

/** A new 6-digit code, leading zeros kept. */
export const newSignInCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0');

export const createEmailSignInService = (deps: EmailSignInServiceDeps) => ({
  /**
   * Email a 6-digit sign-in code and return the requestId the asking tab
   * enters it with. Uniform whether or not the address has an account.
   * Throws on a malformed address, the rate limits, and infrastructure
   * failures; a failed send throws too, after the request is made, so the
   * caller can still answer with the requestId.
   */
  async start(input: {
    email: string;
    /** The caller's IP address, for the per-IP limit (#146). Unknown locally. */
    sourceIp?: string;
  }): Promise<{ requestId: string; send: () => Promise<void> }> {
    if (!isValidEmail(input.email)) {
      throw new AppError('INVALID_INPUT', 'Email is not in a valid shape');
    }
    const email = input.email.trim();
    try {
      await signInCodeStore.reserveSend(rateKeyForEmail(email), input.sourceIp);
    } catch (err) {
      if (err instanceof SignInRateLimited) {
        deps.logger?.warn({ event: 'signin.rate_limited', reason: err.reason }, 'Code refused');
        throw new AppError('RATE_LIMITED', RATE_LIMIT_MESSAGES[err.reason], {
          retryAfterSeconds: err.retryAfterSeconds,
        });
      }
      throw err;
    }

    const id = secret(16);
    const requestSecret = secret(32);
    const code = newSignInCode();
    await signInCodeStore.create({
      id,
      email,
      requestHash: sha256(requestSecret),
      codeHash: codeHash(id, code),
    });
    const minutes = signInCodeStore.CODE_TTL_SECONDS / 60;
    // The code leads the subject, so it shows in the phone's notification
    // and can be typed without opening the email.
    const send = () =>
      deps.emailSender.send({
        to: email,
        subject: `${code} is your Pay Me Back code`,
        category: 'sign-in',
        body: {
          text: `Your Pay Me Back sign-in code:\n\n${code}\n\nType it where you asked for it. It works once and expires in ${minutes} minutes. Never share it. If you didn't ask for it, ignore this email.`,
          html: `<p>Your Pay Me Back sign-in code:</p><p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:16px 0;">${code}</p><p>Type it where you asked for it. It works once and expires in ${minutes} minutes. Never share it. If you didn't ask for it, ignore this email.</p>`,
        },
      });
    deps.logger?.info(
      { event: 'signin.start', emailHash: emailHash(email) },
      'Sign-in code issued',
    );
    return { requestId: `${id}.${requestSecret}`, send };
  },

  /**
   * The tab that asked enters the code. `signedIn` with a session for the
   * right code; `wrong` with the tries left; `expired` once the code is
   * used up, timed out, or the requestId isn't one we gave out.
   */
  async enterCode(input: { requestId: string; code: string }): Promise<CodeEntryResult> {
    const parsed = parseRequestId(input.requestId);
    if (!parsed || !/^[0-9]{6}$/.test(input.code)) return { status: 'expired' };
    const checked = await signInCodeStore.check(
      parsed.id,
      parsed.hash,
      codeHash(parsed.id, input.code),
    );
    if (checked.result === 'wrong') {
      deps.logger?.warn(
        { event: 'signin.code.wrong', attemptsLeft: checked.attemptsLeft },
        'Wrong sign-in code',
      );
      return { status: 'wrong', attemptsLeft: checked.attemptsLeft };
    }
    if (checked.result === 'expired') return { status: 'expired' };
    const result = await signInByEmail(checked.email, deps.jwtSecret);
    deps.logger?.info({ event: 'signin.code.ok', userId: result.user.userId }, 'Signed in by code');
    return { status: 'signedIn', ...result };
  },

  /**
   * An exempt address (TABLE_FEE_EXEMPT_EMAILS) signs straight in: no code.
   * Null for everyone else, who get a code as usual. Anyone who types one
   * of these addresses gets that account; Callum accepted that (1 Nov 2026).
   */
  async exemptSignIn(input: { email: string }): Promise<SignInResult | null> {
    const email = input.email.trim().toLowerCase();
    if (!isValidEmail(email) || !deps.exemptEmails?.has(email)) return null;
    const result = await signInByEmail(email, deps.jwtSecret);
    deps.logger?.warn(
      { event: 'auth.exempt_sign_in', userId: result.user.userId },
      'Exempt sign-in (no code)',
    );
    return result;
  },

  /**
   * LOCAL DEVELOPMENT ONLY — sign in by email with no code. Same account
   * resolution as a code: a known email gets its existing user (and so
   * its bills and sessions); a new email gets a new user. Only reachable
   * when the local server registers the dev route (see src/local.ts).
   */
  async devSignIn(input: { email: string }): Promise<SignInResult> {
    if (!isValidEmail(input.email)) {
      throw new AppError('INVALID_INPUT', 'Email is not in a valid shape');
    }
    const email = input.email.trim().toLowerCase();
    const result = await signInByEmail(email, deps.jwtSecret);
    deps.logger?.warn(
      { event: 'auth.dev_sign_in', userId: result.user.userId },
      'Dev sign-in (no code)',
    );
    return result;
  },

  /**
   * LOCAL AND DEV ONLY — sign in to a test account with no code. Only
   * `@test.invalid` addresses, so a real person's account can't be reached
   * this way. Reachable only when the app mounts the route (see app.ts).
   */
  async testSignIn(input: { email: string }): Promise<SignInResult> {
    const email = input.email.trim().toLowerCase();
    if (!isValidEmail(email) || !isTestAccountEmail(email)) {
      throw new AppError(
        'INVALID_INPUT',
        `Test accounts must use an @${TEST_ACCOUNT_DOMAIN} address`,
      );
    }
    const result = await signInByEmail(email, deps.jwtSecret);
    deps.logger?.warn(
      { event: 'auth.test_sign_in', userId: result.user.userId },
      'Test account sign-in (no code)',
    );
    return result;
  },
});

/** Look up (or create) the user for this email and mint a session JWT. */
async function signInByEmail(email: string, jwtSecret: Uint8Array): Promise<SignInResult> {
  const existing = await authIdentityStore.getByEmail(email);
  let userId: string;
  let displayName: string;
  let tokenVersion = 0;
  if (existing) {
    userId = existing.userId;
    const user = await userStore.get(userId);
    displayName = user?.displayName ?? defaultDisplayName(email);
    tokenVersion = user?.tokenVersion ?? 0;
  } else {
    userId = uuidv7();
    displayName = defaultDisplayName(email);
    const now = new Date().toISOString();
    await authIdentityStore.putByEmail({ email, userId, createdAt: now });
    await userStore.putProfile({ userId, email, displayName });
  }
  const token = await mintSessionToken(
    { userId, email, name: displayName, tokenVersion },
    jwtSecret,
  );
  return { token, user: { userId, email, displayName } };
}

const defaultDisplayName = (email: string): string => {
  // Local-part of the email, with `.`/`_`/`+suffix` stripped. Good
  // enough first-pass guess at the user's name; they can edit later.
  const local = email.split('@')[0] ?? 'user';
  return local.split('+')[0]!.replace(/[._]+/g, ' ').trim() || 'user';
};
