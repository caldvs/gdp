import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

/** How long an emailed sign-in link works. */
const LINK_TTL_SECONDS = 15 * 60;
/**
 * How long the tab that asked can collect its session after the link was
 * opened. Counted from the link's expiry, so a link opened at minute 14
 * still signs the waiting tab in.
 */
const CLAIM_GRACE_SECONDS = 10 * 60;
// Sending limits per address (#76): one link every 30 seconds, and at
// most 5 in any 15-minute window. Stops the app being used to flood
// someone's inbox, which would also count against us with SES.
const MIN_GAP_SECONDS = 30;
const SENDS_PER_WINDOW = 5;
const WINDOW_SECONDS = 15 * 60;

/** Why a link wasn't sent: too soon after the last, or too many lately. */
export class SignInRateLimited extends Error {
  constructor(
    readonly reason: 'too-soon' | 'too-many',
    readonly retryAfterSeconds: number,
  ) {
    super(reason);
    this.name = 'SignInRateLimited';
  }
}

const ratePk = (email: string) => `SIGNINRATE#email:${email.toLowerCase()}`;
const linkKey = (linkId: string) => ({ pk: `SIGNIN#${linkId}`, sk: `SIGNIN#${linkId}` });

/**
 * One sign-in request. `pending` until the emailed link is opened, then
 * `approved`; `claimed` once the tab that asked has collected its session.
 * Only hashes of the two secrets are kept: the link's (in the email) and
 * the request's (held by the tab that asked).
 */
export interface SignInLinkRecord {
  linkId: string;
  email: string;
  status: 'pending' | 'approved' | 'claimed';
  expiresAt: number; // epoch seconds: the link stops working
  claimBy: number; // epoch seconds: the waiting tab must collect by then
}

const now = () => Math.floor(Date.now() / 1000);

export const signInLinkStore = {
  /**
   * Count a send against the address's limits. Throws SignInRateLimited
   * when it's too soon after the last one or too many lately.
   */
  async reserveSend(email: string): Promise<void> {
    const t = now();
    const window = Math.floor(t / WINDOW_SECONDS);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: ratePk(email), sk: `W#${window}` },
          UpdateExpression: 'SET #n = if_not_exists(#n, :zero) + :one, ttlAt = :ttl',
          ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
          ExpressionAttributeNames: { '#n': 'sends' },
          ExpressionAttributeValues: {
            ':zero': 0,
            ':one': 1,
            ':max': SENDS_PER_WINDOW,
            ':ttl': (window + 1) * WINDOW_SECONDS + 60,
          },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new SignInRateLimited('too-many', (window + 1) * WINDOW_SECONDS - t);
      }
      throw err;
    }
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: ratePk(email), sk: 'LAST' },
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
  },

  async create(input: {
    linkId: string;
    email: string;
    linkHash: string;
    requestHash: string;
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
   * The emailed link was opened: pending → approved, once, before it
   * expires, and only with the right secret. Null in every other case.
   */
  async approve(linkId: string, linkHash: string): Promise<SignInLinkRecord | null> {
    try {
      const out = await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: linkKey(linkId),
          UpdateExpression: 'SET #s = :approved, approvedAt = :now',
          ConditionExpression:
            'attribute_exists(pk) AND linkHash = :h AND #s = :pending AND expiresAt > :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':approved': 'approved',
            ':pending': 'pending',
            ':h': linkHash,
            ':now': now(),
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
    const out = await ddb.send(new GetCommand({ TableName: TABLE_NAME, Key: linkKey(linkId) }));
    if (!out.Item || out.Item.requestHash !== requestHash) return null;
    return toRecord(out.Item);
  },

  /** The waiting tab collects its session: approved → claimed, once, in time. */
  async claim(linkId: string, requestHash: string): Promise<SignInLinkRecord | null> {
    try {
      const out = await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: linkKey(linkId),
          UpdateExpression: 'SET #s = :claimed, claimedAt = :now',
          ConditionExpression:
            'attribute_exists(pk) AND requestHash = :h AND #s = :approved AND claimBy > :now',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: {
            ':claimed': 'claimed',
            ':approved': 'approved',
            ':h': requestHash,
            ':now': now(),
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
    status: item.status as SignInLinkRecord['status'],
    expiresAt: item.expiresAt as number,
    claimBy: item.claimBy as number,
  };
}
