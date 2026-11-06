import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

/**
 * #220: the address a guest had their receipt emailed to. Kept with the bill
 * (`SESS#{sessionId}` / `RECEIPTTO#{userId}`) and gone with it (30 days), so
 * a later send knows where the last one went. Never returned to anyone.
 */
const KEEP_DAYS = 30;

export const receiptAddressStore = {
  async put(sessionId: string, userId: string, email: string): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: `SESS#${sessionId}`,
          sk: `RECEIPTTO#${userId}`,
          email,
          ttlAt: Math.floor(Date.now() / 1000) + KEEP_DAYS * 24 * 60 * 60,
        },
      }),
    );
  },
};
