import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

export const s3 = new S3Client({
  region: env.AWS_REGION,
  // Default is 'WHEN_SUPPORTED' which makes the SDK add x-amz-checksum-crc32
  // to presigned PUT URLs. Browsers fetch() can't compute that header, so
  // the upload fails with net::ERR_ABORTED. Restrict to required-only so
  // vanilla PutObject signs just host + content-length.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  ...(env.S3_ENDPOINT && {
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local-secret' },
  }),
});

export const BILLS_BUCKET = env.S3_BUCKET_BILLS;
