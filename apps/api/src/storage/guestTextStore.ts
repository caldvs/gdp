import { randomBytes } from 'node:crypto';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

/**
 * #219/#220: what we've texted a guest about one bill, and the bill's link.
 *
 * - `SESS#{sessionId}` / `GUESTTEXT#{userId}`: the guest's link token, when
 *   the paid text went, how many reminders and when the last went, and
 *   whether they stopped reminders. Never returned whole to anyone.
 * - `BLINK#{token}` / `BLINK`: the link (`/b/{token}`, `/s/{token}`) back to
 *   the session and guest. Works for 30 days after the last text, then the
 *   page says it's gone and the row expires.
 *
 * The token is 96 random bits: the link is the only key to the bill page.
 */
export const LINK_DAYS = 30;
const DAY = 24 * 60 * 60;
const KEEP_STATE_DAYS = 60;

const statePk = (sessionId: string) => `SESS#${sessionId}`;
const stateSk = (userId: string) => `GUESTTEXT#${userId}`;
const linkPk = (token: string) => `BLINK#${token}`;

export interface GuestTextState {
  token?: string;
  paidSentAt?: string;
  reminders: number;
  lastReminderAt?: string;
  autoReminderAt?: string;
  stoppedAt?: string;
}

export interface BillLink {
  token: string;
  sessionId: string;
  userId: string;
  /** Epoch seconds: after this the link is gone. */
  ttlAt: number;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
const keepUntil = () => nowSeconds() + KEEP_STATE_DAYS * DAY;

function failedCondition(err: unknown): boolean {
  return err instanceof ConditionalCheckFailedException;
}

export const guestTextStore = {
  async get(sessionId: string, userId: string): Promise<GuestTextState> {
    const res = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: statePk(sessionId), sk: stateSk(userId) },
      }),
    );
    const i = res.Item ?? {};
    const str = (k: string): Record<string, string> =>
      typeof i[k] === 'string' ? { [k]: i[k] } : {};
    return {
      ...str('token'),
      ...str('paidSentAt'),
      reminders: typeof i.reminders === 'number' ? i.reminders : 0,
      ...str('lastReminderAt'),
      ...str('autoReminderAt'),
      ...str('stoppedAt'),
    };
  },

  /**
   * The guest's link, made on first use, good for another 30 days from now.
   * Returns the token and when it stops working (epoch seconds).
   */
  async link(sessionId: string, userId: string): Promise<{ token: string; ttlAt: number }> {
    const ttlAt = nowSeconds() + LINK_DAYS * DAY;
    let token = (await guestTextStore.get(sessionId, userId)).token;
    if (!token) {
      const fresh = randomBytes(12).toString('base64url');
      try {
        await ddb.send(
          new UpdateCommand({
            TableName: TABLE_NAME,
            Key: { pk: statePk(sessionId), sk: stateSk(userId) },
            UpdateExpression: 'SET #t = :t, ttlAt = :keep',
            ConditionExpression: 'attribute_not_exists(#t)',
            ExpressionAttributeNames: { '#t': 'token' },
            ExpressionAttributeValues: { ':t': fresh, ':keep': keepUntil() },
          }),
        );
        token = fresh;
      } catch (err) {
        if (!failedCondition(err)) throw err;
        token = (await guestTextStore.get(sessionId, userId)).token!;
      }
    }
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: { pk: linkPk(token), sk: 'BLINK', sessionId, userId, ttlAt },
      }),
    );
    return { token, ttlAt };
  },

  /** The link behind a token, or null when it's unknown or past its 30 days. */
  async resolve(token: string): Promise<BillLink | null> {
    if (!/^[A-Za-z0-9_-]{16}$/.test(token)) return null;
    const res = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: linkPk(token), sk: 'BLINK' } }),
    );
    const i = res.Item;
    if (!i || typeof i.ttlAt !== 'number' || i.ttlAt <= nowSeconds()) return null;
    return {
      token,
      sessionId: i.sessionId as string,
      userId: i.userId as string,
      ttlAt: i.ttlAt,
    };
  },

  /** The paid text, once per guest per bill. False when it already went. */
  async reservePaid(sessionId: string, userId: string, at: string): Promise<boolean> {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: statePk(sessionId), sk: stateSk(userId) },
          UpdateExpression: 'SET paidSentAt = :at, ttlAt = :keep',
          ConditionExpression: 'attribute_not_exists(paidSentAt)',
          ExpressionAttributeValues: { ':at': at, ':keep': keepUntil() },
        }),
      );
      return true;
    } catch (err) {
      if (failedCondition(err)) return false;
      throw err;
    }
  },

  /** The paid text didn't go after all: let a later Received try again. */
  async releasePaid(sessionId: string, userId: string): Promise<void> {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: statePk(sessionId), sk: stateSk(userId) },
        UpdateExpression: 'REMOVE paidSentAt',
      }),
    );
  },

  /**
   * #219: count one reminder, if the guest is under `max`, hasn't had one
   * since `notSince`, and hasn't stopped them (an automatic one also needs
   * no automatic one before). False otherwise.
   */
  async reserveReminder(
    sessionId: string,
    userId: string,
    opts: { at: string; notSince: string; max: number; auto?: boolean },
  ): Promise<boolean> {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: statePk(sessionId), sk: stateSk(userId) },
          UpdateExpression:
            'SET reminders = if_not_exists(reminders, :zero) + :one, lastReminderAt = :at, ttlAt = :keep' +
            (opts.auto ? ', autoReminderAt = :at' : ''),
          ConditionExpression:
            '(attribute_not_exists(reminders) OR reminders < :max) AND ' +
            '(attribute_not_exists(lastReminderAt) OR lastReminderAt < :since) AND ' +
            'attribute_not_exists(stoppedAt)' +
            (opts.auto ? ' AND attribute_not_exists(autoReminderAt)' : ''),
          ExpressionAttributeValues: {
            ':zero': 0,
            ':one': 1,
            ':at': opts.at,
            ':since': opts.notSince,
            ':max': opts.max,
            ':keep': keepUntil(),
          },
        }),
      );
      return true;
    } catch (err) {
      if (failedCondition(err)) return false;
      throw err;
    }
  },

  /** A reminder that didn't go after all (the send failed): give it back. */
  async releaseReminder(sessionId: string, userId: string): Promise<void> {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: statePk(sessionId), sk: stateSk(userId) },
          UpdateExpression: 'SET reminders = reminders - :one REMOVE lastReminderAt',
          ConditionExpression: 'reminders > :zero',
          ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
        }),
      );
    } catch (err) {
      if (!failedCondition(err)) throw err;
    }
  },

  /** The guest stopped reminders for this bill (`/s/{token}`). */
  async stop(sessionId: string, userId: string, at: string): Promise<void> {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk: statePk(sessionId), sk: stateSk(userId) },
        UpdateExpression: 'SET stoppedAt = if_not_exists(stoppedAt, :at), ttlAt = :keep',
        ExpressionAttributeValues: { ':at': at, ':keep': keepUntil() },
      }),
    );
  },
};
