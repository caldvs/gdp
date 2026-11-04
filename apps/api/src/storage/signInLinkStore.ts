import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';
import { countInWindow } from './rateCounter.js';

/** How long an emailed sign-in link works. */
const LINK_TTL_SECONDS = 15 * 60;
/**
 * How long the tab that asked can collect its session after the link was
 * opened. Counted from the link's expiry, so a link opened at minute 14
 * still signs the waiting tab in.
 */
const CLAIM_GRACE_SECONDS = 10 * 60;
/**
 * After the tab that asked first collects its session, how long it can
 * collect again. Polls overlap (a refocus and the 2-second timer), and an
 * answer can be lost (a dropped connection, a reload mid-request); without
 * this the second poll was told `expired` and the person saw "Link
 * expired" though they had signed in (4 Nov 2026). Only the holder of the
 * request's secret can collect, and it already has the session.
 */
const RECLAIM_SECONDS = 5 * 60;
// Sending limits per address (#76): one link every 30 seconds, and at
// most 5 in any 15-minute window. Stops the app being used to flood
// someone's inbox, which would also count against us with SES.
const MIN_GAP_SECONDS = 30;
const SENDS_PER_WINDOW = 5;
const WINDOW_SECONDS = 15 * 60;
// And across addresses (#146): at most 20 links an hour from one IP
// address, and 1000 an hour in all, so spraying addresses can't run up
// SES bounces and complaints.
const HOUR_SECONDS = 60 * 60;
const SENDS_PER_IP_HOUR = 20;
const SENDS_PER_HOUR = 1000;

/** Why a link wasn't sent: too soon after the last, too many lately, from one IP, or in all. */
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
const linkKey = (linkId: string) => ({ pk: `SIGNIN#${linkId}`, sk: `SIGNIN#${linkId}` });

/**
 * One sign-in request. `pending` until the emailed link is opened and the
 * person confirms the number, then `approved` (or `denied` if they say it
 * isn't theirs); `claimed` once the tab that asked has collected its
 * session. Only hashes of the two secrets are kept: the link's (in the
 * email) and the request's (held by the tab that asked). `code` is the
 * two-digit number both screens show (#138); it isn't a secret.
 */
export interface SignInLinkRecord {
  linkId: string;
  email: string;
  code: string;
  status: 'pending' | 'approved' | 'denied' | 'claimed';
  expiresAt: number; // epoch seconds: the link stops working
  claimBy: number; // epoch seconds: the waiting tab must collect by then
  claimedAt?: number; // epoch seconds: the waiting tab first collected
}

const now = () => Math.floor(Date.now() / 1000);

export const signInLinkStore = {
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
    linkId: string;
    email: string;
    linkHash: string;
    requestHash: string;
    code: string;
  }): Promise<void> {
    const t = now();
    const expiresAt = t + LINK_TTL_SECONDS;
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          ...linkKey(input.linkId),
          email: input.email,
          linkHash: input.linkHash,
          requestHash: input.requestHash,
          code: input.code,
          status: 'pending',
          createdAt: new Date().toISOString(),
          expiresAt,
          claimBy: expiresAt + CLAIM_GRACE_SECONDS,
          ttlAt: expiresAt + CLAIM_GRACE_SECONDS,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  },

  /**
   * The emailed link was opened: its request, while it's still pending and
   * in time, so the page can show the number. Changes nothing.
   */
  async peek(linkId: string, linkHash: string): Promise<SignInLinkRecord | null> {
    const out = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: linkKey(linkId), ConsistentRead: true }),
    );
    if (!out.Item || out.Item.linkHash !== linkHash) return null;
    const record = toRecord(out.Item);
    return record.status === 'pending' && record.expiresAt > now() ? record : null;
  },

  /** The person said the number isn't theirs: pending → denied, so nobody can use it. */
  async deny(linkId: string, linkHash: string): Promise<boolean> {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: linkKey(linkId),
          UpdateExpression: 'SET #s = :denied, deniedAt = :now',
          ConditionExpression: 'attribute_exists(pk) AND linkHash = :h AND #s = :pending',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':denied': 'denied',
            ':pending': 'pending',
            ':h': linkHash,
            ':now': now(),
          },
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  },

  /**
   * The person confirmed the number: pending → approved, once, before it
   * expires, and only with the right secret and number. Null otherwise.
   */
  async approve(linkId: string, linkHash: string, code: string): Promise<SignInLinkRecord | null> {
    try {
      const out = await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: linkKey(linkId),
          UpdateExpression: 'SET #s = :approved, approvedAt = :now',
          ConditionExpression:
            'attribute_exists(pk) AND linkHash = :h AND #s = :pending AND expiresAt > :now AND code = :code',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':approved': 'approved',
            ':pending': 'pending',
            ':h': linkHash,
            ':now': now(),
            ':code': code,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return out.Attributes ? toRecord(out.Attributes) : null;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  },

  /** The request as the waiting tab sees it. Null if unknown or the secret is wrong. */
  async getForRequest(linkId: string, requestHash: string): Promise<SignInLinkRecord | null> {
    // Strongly consistent: the first poll comes milliseconds after the
    // request is made, and an eventually consistent read can miss it.
    const out = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: linkKey(linkId), ConsistentRead: true }),
    );
    if (!out.Item || out.Item.requestHash !== requestHash) return null;
    return toRecord(out.Item);
  },

  /**
   * The waiting tab collects its session: approved → claimed, in time. It
   * can collect again for RECLAIM_SECONDS after the first time, so
   * overlapping polls and lost answers all end signed in.
   */
  async claim(linkId: string, requestHash: string): Promise<SignInLinkRecord | null> {
    const t = now();
    try {
      const out = await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: linkKey(linkId),
          UpdateExpression: 'SET #s = :claimed, claimedAt = if_not_exists(claimedAt, :now)',
          ConditionExpression:
            'attribute_exists(pk) AND requestHash = :h AND claimBy > :now AND ' +
            '(#s = :approved OR (#s = :claimed AND claimedAt > :reclaimAfter))',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':claimed': 'claimed',
            ':approved': 'approved',
            ':h': requestHash,
            ':now': t,
            ':reclaimAfter': t - RECLAIM_SECONDS,
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return out.Attributes ? toRecord(out.Attributes) : null;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return null;
      throw err;
    }
  },

  LINK_TTL_SECONDS,
};

function toRecord(item: Record<string, unknown>): SignInLinkRecord {
  return {
    linkId: (item.pk as string).slice('SIGNIN#'.length),
    email: item.email as string,
    code: (item.code as string | undefined) ?? '',
    status: item.status as SignInLinkRecord['status'],
    expiresAt: item.expiresAt as number,
    claimBy: item.claimBy as number,
    ...(typeof item.claimedAt === 'number' ? { claimedAt: item.claimedAt } : {}),
  };
}
