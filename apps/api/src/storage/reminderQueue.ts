import { DeleteCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

/**
 * #219: bills waiting for their one automatic reminder. `REMINDQ` /
 * `{sessionId}`, added when the lead shares the bill. The daily job notes
 * when it first sees payments open (`openSeenAt`) and texts a day later.
 * Kept 14 days at most.
 */
const PK = 'REMINDQ';
const KEEP_SECONDS = 14 * 24 * 60 * 60;

export interface QueuedReminder {
  sessionId: string;
  openSeenAt?: string;
}

export const reminderQueue = {
  async add(sessionId: string): Promise<void> {
    await ddb
      .send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            pk: PK,
            sk: sessionId,
            sessionId,
            ttlAt: Math.floor(Date.now() / 1000) + KEEP_SECONDS,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      )
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      });
  },

  async all(): Promise<QueuedReminder[]> {
    const out: QueuedReminder[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await ddb.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': PK },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      );
      for (const i of res.Items ?? []) {
        out.push({
          sessionId: i.sessionId as string,
          ...(typeof i.openSeenAt === 'string' ? { openSeenAt: i.openSeenAt } : {}),
        });
      }
      start = res.LastEvaluatedKey;
    } while (start);
    return out;
  },

  async markOpen(sessionId: string, at: string): Promise<void> {
    await ddb
      .send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: PK, sk: sessionId },
          UpdateExpression: 'SET openSeenAt = if_not_exists(openSeenAt, :at)',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':at': at },
        }),
      )
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') throw err;
      });
  },

  async remove(sessionId: string): Promise<void> {
    await ddb.send(new DeleteCommand({ TableName: TABLE_NAME, Key: { pk: PK, sk: sessionId } }));
  },
};
