import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { ddb, TABLE_NAME } from './ddb.js';

/**
 * Count one against a fixed-window counter row (`<pk>` / `W#<window>`,
 * expiring by TTL after its window). `ok: false` when it's already at
 * `max`, and nothing is counted then. `retryAfterSeconds` is when the
 * window ends.
 */
export async function countInWindow(
  pk: string,
  windowSeconds: number,
  max: number,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<{ ok: boolean; retryAfterSeconds: number }> {
  const window = Math.floor(nowSeconds / windowSeconds);
  const retryAfterSeconds = (window + 1) * windowSeconds - nowSeconds;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { pk, sk: `W#${window}` },
        UpdateExpression: 'SET #n = if_not_exists(#n, :zero) + :one, ttlAt = :ttl',
        ConditionExpression: 'attribute_not_exists(#n) OR #n < :max',
        ExpressionAttributeNames: { '#n': 'sends' },
        ExpressionAttributeValues: {
          ':zero': 0,
          ':one': 1,
          ':max': max,
          ':ttl': (window + 1) * windowSeconds + 60,
        },
      }),
    );
    return { ok: true, retryAfterSeconds };
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return { ok: false, retryAfterSeconds };
    throw err;
  }
}
