import { Hono } from 'hono';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { ddb, TABLE_NAME } from '../storage/ddb.js';
import { s3, BILLS_BUCKET } from '../storage/s3.js';

export const opsRoutes = new Hono();

opsRoutes.get('/healthz', (c) => c.json({ status: 'ok' as const }));

opsRoutes.get('/readyz', async (c) => {
  const checks = await Promise.allSettled([
    ddb.send(new DescribeTableCommand({ TableName: TABLE_NAME })),
    s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET })),
  ]);

  const ddbCheck = checks[0].status === 'fulfilled' ? 'ok' : 'fail';
  const s3Check = checks[1].status === 'fulfilled' ? 'ok' : 'fail';
  const allOk = ddbCheck === 'ok' && s3Check === 'ok';

  return c.json(
    { status: allOk ? ('ok' as const) : ('fail' as const), checks: { ddb: ddbCheck, s3: s3Check } },
    allOk ? 200 : 503,
  );
});
