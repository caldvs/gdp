import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchGetCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { env } from '../config/env.js';

const client = new DynamoDBClient({
  region: env.AWS_REGION,
  ...(env.DYNAMODB_ENDPOINT && {
    endpoint: env.DYNAMODB_ENDPOINT,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  }),
});

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: {
    removeUndefinedValues: true,
    convertClassInstanceToMap: true,
  },
});

export const TABLE_NAME = env.DDB_TABLE_NAME;

const BATCH_GET_MAX = 100;
const BATCH_GET_TRIES = 4;

/**
 * BatchGet any number of keys from the table: 100 a request (DynamoDB's
 * limit), sent together, with unprocessed keys asked for again a few times.
 * Rows that don't exist are simply absent from the result.
 */
export async function batchGetAll(
  keys: ReadonlyArray<{ pk: string; sk: string }>,
  projection?: { expression: string; names: Record<string, string> },
): Promise<Record<string, unknown>[]> {
  const chunks: Array<Array<{ pk: string; sk: string }>> = [];
  for (let i = 0; i < keys.length; i += BATCH_GET_MAX) {
    chunks.push(keys.slice(i, i + BATCH_GET_MAX));
  }
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const out: Record<string, unknown>[] = [];
      let pending: Array<Record<string, unknown>> = chunk;
      for (let tries = 0; pending.length > 0 && tries < BATCH_GET_TRIES; tries += 1) {
        const res = await ddb.send(
          new BatchGetCommand({
            RequestItems: {
              [TABLE_NAME]: {
                Keys: pending,
                ...(projection && {
                  ProjectionExpression: projection.expression,
                  ExpressionAttributeNames: projection.names,
                }),
              },
            },
          }),
        );
        out.push(...(res.Responses?.[TABLE_NAME] ?? []));
        pending = res.UnprocessedKeys?.[TABLE_NAME]?.Keys ?? [];
      }
      return out;
    }),
  );
  return results.flat();
}
