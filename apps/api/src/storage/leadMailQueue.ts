import { DeleteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

/**
 * #221: bills waiting for the lead's email the day after settling.
 * `LEADMAILQ` / `{settledAt}#{sessionId}`: one small partition, sorted by
 * when the bill was settled, so the daily run reads only what's due. Kept
 * 14 days at most if it never sends.
 */
const PK = 'LEADMAILQ';

export interface QueuedLeadMail {
  sessionId: string;
  settledAt: string;
}

export const leadMailQueue = {
  async add(sessionId: string, settledAt: string): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: PK,
          sk: `${settledAt}#${sessionId}`,
          sessionId,
          settledAt,
          ttlAt: Math.floor(Date.now() / 1000) + 14 * 24 * 60 * 60,
        },
      }),
    );
  },

  /** Settled before `before`, oldest first. */
  async due(before: string): Promise<QueuedLeadMail[]> {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND sk < :before',
        ExpressionAttributeValues: { ':pk': PK, ':before': before },
      }),
    );
    return (res.Items ?? []).map((i) => ({
      sessionId: i.sessionId as string,
      settledAt: i.settledAt as string,
    }));
  },

  async remove(item: QueuedLeadMail): Promise<void> {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE_NAME,
        Key: { pk: PK, sk: `${item.settledAt}#${item.sessionId}` },
      }),
    );
  },
};
