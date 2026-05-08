import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
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
