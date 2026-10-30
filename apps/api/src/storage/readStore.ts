import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

/** A bill being read in the background. Kept a day; the bill outlives it. */
export type BillRead = {
  readId: string;
  userId: string;
  uploadId: string;
  status: 'reading' | 'done' | 'failed';
  /** Set when done. */
  billId?: string;
  /** Set when failed: the same code and message the synchronous parse would return. */
  error?: { code: string; message: string; details?: Record<string, unknown> };
  createdAt: string;
};

const readPk = (readId: string) => `READ#${readId}`;
const READ_SK = 'READ';
const TTL_SECONDS = 24 * 60 * 60;

export const readStore = {
  async create(read: BillRead): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: readPk(read.readId),
          sk: READ_SK,
          ttlAt: Math.floor(Date.now() / 1000) + TTL_SECONDS,
          ...read,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  },

  async get(readId: string): Promise<BillRead | null> {
    const out = await ddb.send(
      new GetCommand({ TableName: TABLE_NAME, Key: { pk: readPk(readId), sk: READ_SK } }),
    );
    if (!out.Item) return null;
    const { pk: _pk, sk: _sk, ttlAt: _ttl, ...read } = out.Item;
    return read as BillRead;
  },

  /** Record the outcome. Only a read still `reading` changes, so a late retry can't undo it. */
  async finish(
    readId: string,
    outcome: { status: 'done'; billId: string } | { status: 'failed'; error: BillRead['error'] },
  ): Promise<void> {
    const field = outcome.status === 'done' ? 'billId' : 'error';
    const value = outcome.status === 'done' ? outcome.billId : outcome.error;
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: TABLE_NAME,
          Key: { pk: readPk(readId), sk: READ_SK },
          UpdateExpression: 'SET #status = :status, #field = :value',
          ConditionExpression: '#status = :reading',
          ExpressionAttributeNames: { '#status': 'status', '#field': field },
          ExpressionAttributeValues: {
            ':status': outcome.status,
            ':value': value,
            ':reading': 'reading',
          },
        }),
      );
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return;
      throw err;
    }
  },
};
