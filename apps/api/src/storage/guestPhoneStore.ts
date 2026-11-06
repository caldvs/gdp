import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

/**
 * #214: a guest's verified mobile number, for the bill's texts (reminders,
 * paid). In the session's own item collection (`SESS#{id}` /
 * `GUESTPHONE#{userId}`), so it expires with the bill, and in a row of its
 * own, which session reads skip: nobody at the table, the lead included,
 * ever sees it.
 */
const GUEST_PHONE_TTL_DAYS = 30;
const sk = (userId: string) => `GUESTPHONE#${userId}`;

export const guestPhoneStore = {
  async put(sessionId: string, userId: string, e164: string): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `SESS#${sessionId}`,
          sk: sk(userId),
          e164,
          ttlAt: Math.floor(Date.now() / 1000) + GUEST_PHONE_TTL_DAYS * 24 * 60 * 60,
        },
      }),
    );
  },

  async get(sessionId: string, userId: string): Promise<string | null> {
    const res = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: `SESS#${sessionId}`, sk: sk(userId) } }),
    );
    return typeof res.Item?.e164 === 'string' ? res.Item.e164 : null;
  },
};
