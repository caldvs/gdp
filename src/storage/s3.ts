import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';

export const s3 = new S3Client({
  region: env.AWS_REGION,
  ...(env.S3_ENDPOINT && {
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local-secret' },
  }),
});

export const BILLS_BUCKET = env.S3_BUCKET_BILLS;
