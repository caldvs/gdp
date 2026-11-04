import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { timingSafeEqual } from 'node:crypto';
import { ddb, TABLE_NAME } from './ddb.js';
import { countInWindow } from './rateCounter.js';

/** How long an emailed sign-in code works. */
const CODE_TTL_SECONDS = 15 * 60;
/** Wrong guesses a code allows before it stops working. */
const MAX_ATTEMPTS = 5;
/**
 * After the right code is first entered, how long the same tab can enter
 * it again and still be signed in. A phone that autofills the code and a
 * tap on Continue can send it twice, and an answer can be lost; neither
 * should end in "Code expired" for someone who just signed in.
 */
const RECHECK_SECONDS = 5 * 60;
// Sending limits per address (#76): one code every 30 seconds, and at
// most 5 in any 15-minute window. Stops the app being used to flood
// someone's inbox, which would also count against us with SES.
const MIN_GAP_SECONDS = 30;
const SENDS_PER_WINDOW = 5;
const WINDOW_SECONDS = 15 * 60;
// And across addresses (#146): at most 20 codes an hour from one IP
// address, and 1000 an hour in all, so spraying addresses can't run up
// SES bounces and complaints.
const HOUR_SECONDS = 60 * 60;
const SENDS_PER_IP_HOUR = 20;
const SENDS_PER_HOUR = 1000;

/** Why a code wasn't sent: too soon after the last, too many lately, from one IP, or in all. */
export class SignInRateLimited extends Error {
  constructor(
    readonly reason: 'too-soon' | 'too-many' | 'ip' | 'global',
    readonly retryAfterSeconds: number,
  ) {
    super(reason);
    this.name = 'SignInRateLimited';
  }
}

const ratePk = (email: string) => `SIGNINRATE#email:${email.toLowerCase()}`;
const ipRatePk = (ip: string) => `SIGNINRATE#ip:${ip}`;
const GLOBAL_RATE_PK = 'SIGNINRATE#all';
const codeKey = (id: string) => ({ pk: `SIGNIN#${id}`, sk: `SIGNIN#${id}` });

/**
 * One sign-in request: a 6-digit code emailed to `email`, which only the
 * tab that asked (holding the request's secret) can enter. Only hashes are
 * kept: of the request's secret, and of the code (salted with the id).
 * `pending` until the right code is entered, then `used`.
 */
export interface SignInCodeRecord {
  id: string;
  email: string;
  status: 'pending' | 'used';
  attempts: number;
  expiresAt: number; // epoch seconds: the code stops working
}

/** What entering a code came to. */
export type CodeCheck =
  | { result: 'ok'; email: string }
  | { result: 'wrong'; attemptsLeft: number }
  | { result: 'expired' };

const now = () => Math.floor(Date.now() / 1000);

export const signInCodeStore = {
  /**
   * Count a send against the limits: the address's (`rateKey`, already
   * normalised so `+tags` and Gmail dots share one allowance), the caller's
   * IP address when known, and the hourly total. Throws SignInRateLimited
   * when any is used up.
   */
  async reserveSend(rateKey: string, sourceIp?: string): Promise<void> {
    const t = now();
    const perAddress = await countInWindow(ratePk(rateKey), WINDOW_SECONDS, SENDS_PER_WINDOW, t);
    if (!perAddress.ok) throw new SignInRateLimited('too-many', perAddress.retryAfterSeconds);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: ratePk(rateKey), sk: 'LAST' },
          UpdateExpression: 'SET sentAt = :now, ttlAt = :ttl',
          ConditionExpression: 'attribute_not_exists(sentAt) OR sentAt <= :cutoff',
          ExpressionAttributeValues: {
            ':now': t,
            ':cutoff': t - MIN_GAP_SECONDS,
            ':ttl': t + MIN_GAP_SECONDS + 60,
          },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new SignInRateLimited('too-soon', MIN_GAP_SECONDS);
      }
      throw err;
    }
    // Only sends the address's own limits allowed count towards these.
    if (sourceIp) {
      const perIp = await countInWindow(ipRatePk(sourceIp), HOUR_SECONDS, SENDS_PER_IP_HOUR, t);
      if (!perIp.ok) throw new SignInRateLimited('ip', perIp.retryAfterSeconds);
    }
    const all = await countInWindow(GLOBAL_RATE_PK, HOUR_SECONDS, SENDS_PER_HOUR, t);
    if (!all.ok) throw new SignInRateLimited('global', all.retryAfterSeconds);
  },

  async create(input: {
    id: string;
    email: string;
    requestHash: string;
    codeHash: string;
  }): Promise<void> {
    const expiresAt = now() + CODE_TTL_SECONDS;
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...codeKey(input.id),
          email: input.email,
          requestHash: input.requestHash,
          codeHash: input.codeHash,
          status: 'pending',
          attempts: 0,
          createdAt: new Date().toISOString(),
          expiresAt,
          ttlAt: expiresAt + RECHECK_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  },

  /**
   * The tab that asked enters a code. Every try counts, right or wrong, and
   * a request takes MAX_ATTEMPTS at most. The right code marks it used; the
   * same tab can enter it again for RECHECK_SECONDS after that. `expired`
   * for an unknown request, a wrong request secret, a used-up or timed-out
   * code: the tab asks for a new one.
   */
  async check(id: string, requestHash: string, codeHash: string): Promise<CodeCheck> {
    const t = now();
    let item: Record<string, unknown>;
    try {
      const out = await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: codeKey(id),
          UpdateExpression: 'ADD attempts :one',
          ConditionExpression:
            'attribute_exists(pk) AND requestHash = :h AND attempts < :max AND ' +
            '((#s = :pending AND expiresAt > :now) OR (#s = :used AND usedAt > :recheckAfter))',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':h': requestHash,
            ':max': MAX_ATTEMPTS + 1,
            ':pending': 'pending',
            ':used': 'used',
            ':now': t,
            ':recheckAfter': t - RECHECK_SECONDS,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      item = out.Attributes!;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return { result: 'expired' };
      throw err;
    }
    const attempts = item.attempts as number;
    if (!sameHash(item.codeHash as string, codeHash)) {
      // The extra allowance (MAX_ATTEMPTS + 1) is only for re-entering the
      // right code once it's used; a pending code gets MAX_ATTEMPTS tries.
      const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attempts);
      return attemptsLeft > 0 && item.status === 'pending'
        ? { result: 'wrong', attemptsLeft }
        : { result: 'expired' };
    }
    if (item.status === 'pending') {
      if (attempts > MAX_ATTEMPTS) return { result: 'expired' };
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: codeKey(id),
            UpdateExpression: 'SET #s = :used, usedAt = :now',
            ConditionExpression: '#s = :pending OR #s = :used',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':used': 'used', ':pending': 'pending', ':now': t },
          }),
        );
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException) return { result: 'expired' };
        throw err;
      }
    }
    return { result: 'ok', email: item.email as string };
  },

  /** The request as stored (tests and support). Null if unknown. */
  async get(id: string): Promise<SignInCodeRecord | null> {
    const out = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: codeKey(id), ConsistentRead: true }),
    );
    if (!out.Item) return null;
    return {
      id,
      email: out.Item.email as string,
      status: out.Item.status as SignInCodeRecord['status'],
      attempts: out.Item.attempts as number,
      expiresAt: out.Item.expiresAt as number,
    };
  },

  CODE_TTL_SECONDS,
  MAX_ATTEMPTS,
};

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}
