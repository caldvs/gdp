import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

export interface CachedResponse {
  status: number;
  body: string;
  contentType: string;
}

export interface IdempotencyRecord {
  bodyHash: string;
  response: CachedResponse;
}

const TTL_SECONDS = 24 * 60 * 60;

const pk = (userId: string, endpoint: string) => `IDMP#${userId}#${endpoint}`;
const sk = (key: string) => `KEY#${key}`;

export const idempotencyStore = {
  async get(userId: string, endpoint: string, key: string): Promise<IdempotencyRecord | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: pk(userId, endpoint), sk: sk(key) },
      }),
    );
    if (!result.Item) return null;
    return {
      bodyHash: result.Item.bodyHash as string,
      response: result.Item.response as CachedResponse,
    };
  },

  async put(
    userId: string,
    endpoint: string,
    key: string,
    record: IdempotencyRecord,
  ): Promise<void> {
    const ttlAt = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: pk(userId, endpoint),
          sk: sk(key),
          bodyHash: record.bodyHash,
          response: record.response,
          ttlAt,
        },
      }),
    );
  },
};
