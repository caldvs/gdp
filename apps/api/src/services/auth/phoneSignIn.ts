import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { AppError } from '../../errors/AppError.js';
import { SignInRateLimited, signInCodeStore } from '../../storage/signInCodeStore.js';
import { authIdentityStore } from '../../storage/authIdentityStore.js';
import { userStore } from '../../storage/userStore.js';
import { mintSessionToken } from './sessionToken.js';
import { maskPhone, parseUkMobile } from '../messaging/phone.js';
import type { SmsSender } from '../messaging/sms.js';
import type { Logger } from '../../logging/logger.js';

/**
 * #213: sign in with your phone. A 4-digit code goes by text (#231, AWS
 * End User Messaging SMS); the tab that asked enters it. Same request-secret
 * scheme, attempt limit and hashing as
 * email sign-in; tighter send limits, because every code costs money.
 * Numbers are stored as E.164 and never logged whole.
 */

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');
const secret = (bytes: number): string => randomBytes(bytes).toString('base64url');
const REQUEST_RE = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;
const codeHash = (id: string, code: string): string => sha256(`${id}:${code}`);

export const newPhoneCode = (): string => String(randomInt(0, 10_000)).padStart(4, '0');

/** The text (#213's wording). The last line lets phones offer the code to this site. */
export const codeText = (code: string): string =>
  `${code} is your Pay Me Back code. Don’t share this code.\n\n@paymeback.dev #${code}`;

const RATE_LIMIT_MESSAGES: Record<SignInRateLimited['reason'], string> = {
  'too-soon': 'We’ve just sent a code. Check your phone, or try again in a moment.',
  'too-many': 'Too many codes for this number. Try again in an hour.',
  ip: 'Too many codes from here. Try again later.',
  global: 'Sign-in is busy. Try again in a few minutes.',
};

export interface PhoneSignInDeps {
  /** #231: texts. Null: no SMS here, so no phone sign-in. */
  sms: SmsSender | null;
  jwtSecret: Uint8Array;
  logger?: Logger;
}

export type PhoneSignInResult = {
  token: string;
  user: { userId: string; email: string; displayName: string };
  /** A new account: the web app asks for a name and an email for bill emails. */
  isNew: boolean;
};

/** A code checked, without signing anyone in (#214: guests). */
export type PhoneCodeCheck =
  | { status: 'ok'; phone: string }
  | { status: 'wrong'; attemptsLeft: number }
  | { status: 'expired' };

export type PhoneCodeResult =
  | ({ status: 'signedIn' } & PhoneSignInResult)
  | { status: 'wrong'; attemptsLeft: number }
  | { status: 'expired' };

export const createPhoneSignInService = (deps: PhoneSignInDeps) => ({
  available: (): { sms: boolean } => ({ sms: !!deps.sms }),

  async start(input: {
    phone: string;
    sourceIp?: string;
  }): Promise<{ requestId: string; phone: string }> {
    const sms = deps.sms;
    if (!sms) throw new AppError('CHANNEL_UNAVAILABLE', 'Texts aren’t available here');
    const e164 = parseUkMobile(input.phone);
    if (!e164) throw new AppError('INVALID_INPUT', 'Enter a UK mobile number');
    try {
      await signInCodeStore.reservePhoneSend(e164, input.sourceIp);
    } catch (err) {
      if (err instanceof SignInRateLimited) {
        deps.logger?.warn(
          { event: 'signin.phone.rate_limited', reason: err.reason },
          'Code refused',
        );
        throw new AppError('RATE_LIMITED', RATE_LIMIT_MESSAGES[err.reason], {
          retryAfterSeconds: err.retryAfterSeconds,
        });
      }
      throw err;
    }
    const id = secret(16);
    const requestSecret = secret(32);
    const code = newPhoneCode();
    await signInCodeStore.create({
      id,
      phone: e164,
      requestHash: sha256(requestSecret),
      codeHash: codeHash(id, code),
    });
    await sms.send(e164, codeText(code));
    deps.logger?.info(
      {
        event: 'signin.phone.sent',
        to: maskPhone(e164),
        via: 'sms',
      },
      'Phone code sent',
    );
    return { requestId: `${id}.${requestSecret}`, phone: e164 };
  },

  async enterCode(input: { requestId: string; code: string }): Promise<PhoneCodeResult> {
    const checked = await checkPhoneCode(input);
    if (checked.status !== 'ok') return checked;
    const result = await signInByPhone(checked.phone, deps.jwtSecret);
    deps.logger?.info(
      { event: 'signin.phone.ok', userId: result.user.userId, isNew: result.isNew },
      'Signed in by phone',
    );
    return { status: 'signedIn', ...result };
  },
});

/** The number a code went to, once the right code is entered (once only). */
export async function checkPhoneCode(input: {
  requestId: string;
  code: string;
}): Promise<PhoneCodeCheck> {
  const m = REQUEST_RE.exec(input.requestId);
  if (!m || !/^[0-9]{4}$/.test(input.code)) return { status: 'expired' };
  const id = m[1]!;
  const checked = await signInCodeStore.check(id, sha256(m[2]!), codeHash(id, input.code));
  if (checked.result === 'wrong') return { status: 'wrong', attemptsLeft: checked.attemptsLeft };
  if (checked.result === 'expired' || !checked.phone) return { status: 'expired' };
  return { status: 'ok', phone: checked.phone };
}

async function signInByPhone(e164: string, jwtSecret: Uint8Array): Promise<PhoneSignInResult> {
  let isNew = false;
  let userId = (await authIdentityStore.getByPhone(e164))?.userId;
  if (!userId) {
    const fresh = randomUUID();
    try {
      await authIdentityStore.putByPhone({
        e164,
        userId: fresh,
        createdAt: new Date().toISOString(),
      });
      userId = fresh;
      isNew = true;
    } catch {
      // Two tabs raced to create it: use the one that won.
      userId = (await authIdentityStore.getByPhone(e164))?.userId;
      if (!userId) throw new AppError('INTERNAL_ERROR', 'Could not sign in');
    }
  }
  const user = isNew ? null : await userStore.get(userId);
  if (isNew) await userStore.updateProfile({ userId });
  const displayName = user?.displayName ?? '';
  const email = user?.email ?? '';
  const token = await mintSessionToken(
    {
      userId,
      email,
      ...(displayName ? { name: displayName } : {}),
      tokenVersion: user?.tokenVersion ?? 0,
    },
    jwtSecret,
  );
  return { token, user: { userId, email, displayName }, isNew: isNew || !displayName };
}
