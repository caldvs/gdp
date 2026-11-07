import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

export interface CachedResponse {
  status: number;
  body: string;
  contentType: string;
}

/** `response` is absent while the first request with the key is still running. */
export interface IdempotencyRecord {
  bodyHash: string;
  response?: CachedResponse;
}

const TTL_SECONDS = 24 * 60 * 60;
// How long a reservation holds the key if its request never finishes (a
// crashed Lambda). Longer than the API Lambda's 60s timeout.
const RESERVATION_SECONDS = 90;

const pk = (userId: string, endpoint: string) => `IDMP#${userId}#${endpoint}`;
const sk = (key: string) => `KEY#${key}`;
const nowSeconds = () => Math.floor(Date.now() / 1000);

export const idempotencyStore = {
  async get(userId: string, endpoint: string, key: string): Promise<IdempotencyRecord | null> {
    const result = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: pk(userId, endpoint), sk: sk(key) },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;
    return {
      bodyHash: result.Item.bodyHash as string,
      ...(result.Item.response ? { response: result.Item.response as CachedResponse } : {}),
    };
  },

  /**
   * Claim the key before running the request, so two requests sent with
   * it at once can't both run. Returns null when this request holds it,
   * else the record already there (finished, or still running). A
   * reservation whose request never finished can be taken over once it
   * lapses.
   */
  async reserve(
    userId: string,
    endpoint: string,
    key: string,
    bodyHash: string,
  ): Promise<IdempotencyRecord | null> {
    const now = nowSeconds();
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE_NAME,
          Item: {
            pk: pk(userId, endpoint),
            sk: sk(key),
            bodyHash,
            pendingUntil: now + RESERVATION_SECONDS,
            ttlAt: now + TTL_SECONDS,
          },
          ConditionExpression:
            'attribute_not_exists(pk) OR (attribute_not_exists(#r) AND pendingUntil < :now)',
          ExpressionAttributeNames: { '#r': 'response' },
          ExpressionAttributeValues: { ':now': now },
        }),
      );
      return null;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // Released in between: report it as still running; the client retries.
      return (await this.get(userId, endpoint, key)) ?? { bodyHash };
    }
  },

  /** Let the key go after a failed request, so a retry runs it again. */
  async release(userId: string, endpoint: string, key: string): Promise<void> {
    try {
      await ddb.send(
        new DeleteCommand({
          TableName: TABLE_NAME,
          Key: { pk: pk(userId, endpoint), sk: sk(key) },
          ConditionExpression: 'attribute_not_exists(#r)',
          ExpressionAttributeNames: { '#r': 'response' },
        }),
      );
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
    }
  },

  /** Store the finished response, replacing the reservation. */
  async put(
    userId: string,
    endpoint: string,
    key: string,
    record: Required<IdempotencyRecord>,
  ): Promise<void> {
    await ddb.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          pk: pk(userId, endpoint),
          sk: sk(key),
          bodyHash: record.bodyHash,
          response: record.response,
          ttlAt: nowSeconds() + TTL_SECONDS,
        },
      }),
    );
  },
};
