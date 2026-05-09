/**
 * Bootstrap the local dev stack: ensure DynamoDB Local has the table,
 * MinIO has the bucket, and the bucket has permissive CORS so the Expo
 * web client can PUT directly to presigned URLs.
 *
 * Idempotent — safe to run on every `npm run dev`.
 */

import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ResourceNotFoundException,
  type CreateTableCommandInput,
} from '@aws-sdk/client-dynamodb';
import {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
} from '@aws-sdk/client-s3';
import { tableSchema } from '../infra/tableSchema.js';

const TABLE = process.env.DDB_TABLE_NAME ?? 'gdp-dev';
const BUCKET = process.env.S3_BUCKET_BILLS ?? 'gdp-bills-raw-dev';
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
  // MinIO doesn't implement the auto-applied x-amz-checksum-* headers the
  // SDK adds by default; PutBucketCors fails with 501 NotImplemented.
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

async function ensureTable(): Promise<void> {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
    console.log(`✓ DDB table ${TABLE} exists`);
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
    TableName: TABLE,
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
  console.log(`✓ DDB table ${TABLE} created`);
}

async function ensureBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`✓ S3 bucket ${BUCKET} exists`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log(`✓ S3 bucket ${BUCKET} created`);
  }

  // MinIO doesn't implement PutBucketCors via the S3 API — CORS is set via
  // server-side env vars (MINIO_API_CORS_ALLOW_ORIGIN). Try the call against
  // real S3 endpoints, warn-and-skip on MinIO. Not blocking for API tests
  // (no browser involved); only matters for browser → local-S3 PUTs.
  try {
    await s3.send(
      new PutBucketCorsCommand({
        Bucket: BUCKET,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: ['*'],
              AllowedMethods: ['PUT', 'GET', 'HEAD'],
              AllowedHeaders: ['*'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 600,
            },
          ],
        },
      }),
    );
    console.log(`✓ S3 bucket ${BUCKET} CORS applied`);
  } catch (e) {
    const code = (e as { Code?: string; name?: string }).Code ?? (e as Error).name ?? 'unknown';
    if (code === 'NotImplemented') {
      console.log(
        `⚠ S3 bucket ${BUCKET} CORS skipped (MinIO doesn't implement PutBucketCors). ` +
          `For browser → local-S3 PUTs, configure MinIO with MINIO_API_CORS_ALLOW_ORIGIN.`,
      );
    } else {
      throw e;
    }
  }
}

async function main(): Promise<void> {
  console.log(`→ DDB ${DDB_ENDPOINT} | S3 ${S3_ENDPOINT}`);
  await ensureTable();
  await ensureBucket();
  console.log('\n✓ local stack ready');
}

main().catch((e) => {
  console.error('bootstrap failed:', e);
  process.exit(1);
});
