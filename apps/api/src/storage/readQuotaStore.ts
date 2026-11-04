import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

/**
 * Bill reads that reach the model, per user per UTC day (#145). Photos read
 * before come from the cache and don't count. A real lead reads a handful of
 * bills a month; this only stops a loop running up Bedrock costs.
 */
export const READS_PER_DAY = 20;
const DAY_SECONDS = 24 * 60 * 60;

/** The user has used today's reads. */
export class ReadQuotaExceeded extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('read quota exceeded');
    this.name = 'ReadQuotaExceeded';
  }
}

export const readQuotaStore = {
  READS_PER_DAY,

  /** Count one read against today's quota, or throw ReadQuotaExceeded. */
  async reserve(userId: string, nowMs: number = Date.now()): Promise<void> {
    const t = Math.floor(nowMs / 1000);
    const day = Math.floor(t / DAY_SECONDS);
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: `READQ#${userId}`, sk: `D#${day}` },
          UpdateExpression: 'SET #n = if_not_exists(#n, :zero) + :one, ttlAt = :ttl',
          ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
          ExpressionAttributeNames: { '#n': 'reads' },
          ExpressionAttributeValues: {
            ':zero': 0,
            ':one': 1,
            ':max': READS_PER_DAY,
            ':ttl': (day + 2) * DAY_SECONDS,
          },
        }),
      );
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) {
        throw new ReadQuotaExceeded((day + 1) * DAY_SECONDS - t);
      }
      throw err;
    }
  },
};
