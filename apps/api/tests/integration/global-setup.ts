/**
 * Global setup for integration tests.
 * Runs once before any test starts.
 *
 * Requires `docker compose up -d` to have been run beforehand
 * (DynamoDB Local on :8000, LocalStack S3 on :4566).
 */

import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { tableSchema } from '../../infra/tableSchema.js';

const TEST_TABLE = process.env.DDB_TABLE_NAME ?? 'gdp-test';
const TEST_BUCKET = process.env.S3_BUCKET_BILLS ?? 'gdp-bills-raw-test';
const DDB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000';
const S3_ENDPOINT = process.env.S3_ENDPOINT ?? 'http://localhost:9000';

const ddb = new DynamoDBClient({
  region: 'eu-west-2',
  endpoint: DDB_ENDPOINT,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local-secret' },
});

const s3 = new S3Client({
  region: 'eu-west-2',
  endpoint: S3_ENDPOINT,
  forcePathStyle: true,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local-secret' },
});

async function ensureTable(): Promise<void> {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: TEST_TABLE }));
    return;
  } catch (err) {
    if (!(err instanceof ResourceNotFoundException)) throw err;
  }

  const attributeDefs = new Map<string, 'S'>([
    [tableSchema.partitionKey, 'S'],
    [tableSchema.sortKey, 'S'],
  ]);
  for (const gsi of tableSchema.globalSecondaryIndexes) {
    attributeDefs.set(gsi.partitionKey, 'S');
    if ('sortKey' in gsi && gsi.sortKey) attributeDefs.set(gsi.sortKey, 'S');
  }

  const input: CreateTableCommandInput = {
    TableName: TEST_TABLE,
    BillingMode: 'PAY_PER_REQUEST',
    AttributeDefinitions: [...attributeDefs.entries()].map(([name, type]) => ({
      AttributeName: name,
      AttributeType: type,
    })),
    KeySchema: [
      { AttributeName: tableSchema.partitionKey, KeyType: 'HASH' },
      { AttributeName: tableSchema.sortKey, KeyType: 'RANGE' },
    ],
    GlobalSecondaryIndexes: tableSchema.globalSecondaryIndexes.map((gsi) => ({
      IndexName: gsi.indexName,
      KeySchema: [
        { AttributeName: gsi.partitionKey, KeyType: 'HASH' as const },
        ...('sortKey' in gsi && gsi.sortKey
          ? [{ AttributeName: gsi.sortKey, KeyType: 'RANGE' as const }]
          : []),
      ],
      Projection: { ProjectionType: 'ALL' },
    })),
  };

  await ddb.send(new CreateTableCommand(input));
}

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: TEST_BUCKET }));
    return;
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: TEST_BUCKET }));
  }
}

export default async function setup(): Promise<void> {
  process.env.DDB_TABLE_NAME = TEST_TABLE;
  process.env.S3_BUCKET_BILLS = TEST_BUCKET;
  process.env.DYNAMODB_ENDPOINT = DDB_ENDPOINT;
  process.env.S3_ENDPOINT = S3_ENDPOINT;
  process.env.AWS_REGION = 'eu-west-2';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';

  try {
    await ensureTable();
    await ensureBucket();
  } catch (err) {
    throw new Error(
      `Integration tests need DynamoDB Local on ${DDB_ENDPOINT} and S3 on ${S3_ENDPOINT} ` +
        `(run \`docker compose up -d\` in apps/api). Underlying error: ${String(err)}`,
      { cause: err },
    );
  }
}
