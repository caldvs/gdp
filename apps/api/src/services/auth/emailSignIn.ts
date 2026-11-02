import { createHash, randomBytes } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { AppError } from '../../errors/AppError.js';
import { SignInRateLimited, signInLinkStore } from '../../storage/signInLinkStore.js';
import { authIdentityStore } from '../../storage/authIdentityStore.js';
import { userStore } from '../../storage/userStore.js';
import { mintSessionToken } from './sessionToken.js';
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
 * Both the emailed link token and the waiting tab's requestId are
 * `<linkId>.<secret>`: the id finds the row, the secret (only its hash is
 * stored) proves the holder got it from the email or from /email/start.
 */
const TOKEN_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const parseToken = (raw: string): { linkId: string; hash: string } | null => {
  const m = TOKEN_RE.exec(raw);
  return m ? { linkId: m[1]!, hash: sha256(m[2]!) } : null;
};

export interface EmailSignInServiceDeps {
  emailSender: EmailSender;
  jwtSecret: Uint8Array;
  logger?: Logger;
  /** Sign in with just the email, no link (TABLE_FEE_EXEMPT_EMAILS). */
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

export type SignInRequestStatus =
  { status: 'pending' } | ({ status: 'signedIn' } & SignInResult) | { status: 'expired' };

export const createEmailSignInService = (deps: EmailSignInServiceDeps) => ({
  /**
   * Email a one-time sign-in link and return the requestId the asking tab
   * waits on. Uniform whether or not the address has an account. Throws
   * on a malformed address, the rate limits, and infrastructure failures;
   * a failed send throws too, after the request is made, so the caller can
   * still answer with the requestId.
   */
  async start(input: {
    email: string;
    /** Where the link points: the web app's origin, e.g. https://paymeback.dev. */
    appBaseUrl: string;
  }): Promise<{ requestId: string; send: () => Promise<void> }> {
    if (!isValidEmail(input.email)) {
      throw new AppError('INVALID_INPUT', 'Email is not in a valid shape');
    }
    const email = input.email.trim();
    try {
      await signInLinkStore.reserveSend(email);
    } catch (err) {
      if (err instanceof SignInRateLimited) {
        deps.logger?.warn({ event: 'signin.rate_limited', reason: err.reason }, 'Link refused');
        throw new AppError(
          'RATE_LIMITED',
          err.reason === 'too-soon'
            ? 'We’ve just sent a link. Check your email, or try again in a moment.'
            : 'Too many links for this address. Wait a few minutes and try again.',
          { retryAfterSeconds: err.retryAfterSeconds },
        );
      }
      throw err;
    }

    const linkId = secret(16);
    const linkSecret = secret(32);
    const requestSecret = secret(32);
    await signInLinkStore.create({
      linkId,
      email,
      linkHash: sha256(linkSecret),
      requestHash: sha256(requestSecret),
    });
    // The token rides in the fragment, which browsers never send to a
    // server, so it stays out of access and proxy logs.
    const link = `${input.appBaseUrl.replace(/\/+$/, '')}/sign-in/verify#t=${linkId}.${linkSecret}`;
    const minutes = signInLinkStore.LINK_TTL_SECONDS / 60;
    const send = () =>
      deps.emailSender.send({
        to: email,
        subject: 'Sign in to paymeback.dev',
        category: 'sign-in',
        body: {
          text: `Sign in to paymeback.dev:\n\n${link}\n\nThe link works once and expires in ${minutes} minutes. If you didn't ask for it, ignore this email.`,
          html: `<p><a href="${link}" style="display:inline-block;padding:12px 20px;background:#1f6feb;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600;">Sign in</a></p><p>Or open this link: <a href="${link}">${link}</a></p><p>The link works once and expires in ${minutes} minutes. If you didn't ask for it, ignore this email.</p>`,
        },
      });
    deps.logger?.info({ event: 'signin.start', email }, 'Sign-in link issued');
    return { requestId: `${linkId}.${requestSecret}`, send };
  },

  /**
   * The emailed link was opened: sign that tab in. Works once, before it
   * expires. Every failure is AUTH_INVALID, so they can't be told apart.
   */
  async openLink(input: { token: string }): Promise<SignInResult> {
    const parsed = parseToken(input.token);
    const record = parsed ? await signInLinkStore.approve(parsed.linkId, parsed.hash) : null;
    if (!record) throw new AppError('AUTH_INVALID', 'Link expired');
    const result = await signInByEmail(record.email, deps.jwtSecret);
    deps.logger?.info(
      { event: 'signin.link.ok', userId: result.user.userId, email: record.email },
      'Sign-in link opened',
    );
    return result;
  },

  /**
   * The tab that asked, checking in. `signedIn` (with its own session)
   * once the link has been opened, and only the first time; `expired`
   * for an unknown, wrong, used or out-of-time request.
   */
  async requestStatus(input: { requestId: string }): Promise<SignInRequestStatus> {
    const parsed = parseToken(input.requestId);
    if (!parsed) return { status: 'expired' };
    const record = await signInLinkStore.getForRequest(parsed.linkId, parsed.hash);
    const t = Math.floor(Date.now() / 1000);
    if (!record) return { status: 'expired' };
    if (record.status === 'pending') {
      return record.expiresAt > t ? { status: 'pending' } : { status: 'expired' };
    }
    if (record.status !== 'approved') return { status: 'expired' };
    const claimed = await signInLinkStore.claim(parsed.linkId, parsed.hash);
    if (!claimed) return { status: 'expired' };
    const result = await signInByEmail(claimed.email, deps.jwtSecret);
    deps.logger?.info(
      { event: 'signin.request.claimed', userId: result.user.userId },
      'Waiting tab signed in',
    );
    return { status: 'signedIn', ...result };
  },

  /**
   * An exempt address (TABLE_FEE_EXEMPT_EMAILS) signs straight in: no link.
   * Null for everyone else, who get a link as usual. Anyone who types one
   * of these addresses gets that account; Callum accepted that (1 Nov 2026).
   */
  async exemptSignIn(input: { email: string }): Promise<SignInResult | null> {
    const email = input.email.trim().toLowerCase();
    if (!isValidEmail(email) || !deps.exemptEmails?.has(email)) return null;
    const result = await signInByEmail(email, deps.jwtSecret);
    deps.logger?.warn(
      { event: 'auth.exempt_sign_in', userId: result.user.userId, email },
      'Exempt sign-in (no link)',
    );
    return result;
  },

  /**
   * LOCAL DEVELOPMENT ONLY — sign in by email with no link. Same account
   * resolution as a link: a known email gets its existing user (and so
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
      { event: 'auth.dev_sign_in', userId: result.user.userId, email },
      'Dev sign-in (no link)',
    );
    return result;
  },

  /**
   * LOCAL AND DEV ONLY — sign in to a test account with no link. Only
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
      { event: 'auth.test_sign_in', userId: result.user.userId, email },
      'Test account sign-in (no link)',
    );
    return result;
  },
});

/** Look up (or create) the user for this email and mint a session JWT. */
async function signInByEmail(email: string, jwtSecret: Uint8Array): Promise<SignInResult> {
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

const defaultDisplayName = (email: string): string => {
  // Local-part of the email, with `.`/`_`/`+suffix` stripped. Good
  // enough first-pass guess at the user's name; they can edit later.
  const local = email.split('@')[0] ?? 'user';
  return local.split('+')[0]!.replace(/[._]+/g, ' ').trim() || 'user';
};
