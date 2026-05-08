import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v7 as uuidv7 } from 'uuid';
import { s3, BILLS_BUCKET } from '../../storage/s3.js';
import { billStore } from '../../storage/billStore.js';

export interface UploadSlot {
  status: 'new';
  uploadId: string;
  url: string;
  expiresAt: string;
  maxBytes: number;
}

export interface UploadDuplicate {
  status: 'duplicate';
  billId: string;
}

export type UploadResult = UploadSlot | UploadDuplicate;

const URL_TTL_SECONDS = 300;

export const uploadKey = (userId: string, uploadId: string): string => `${userId}/${uploadId}`;

export const uploadService = {
  async requestUpload(input: {
    userId: string;
    sha256: string;
    sizeBytes: number;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  }): Promise<UploadResult> {
    const existing = await billStore.findByImageHash(input.sha256);
    if (existing) {
      return { status: 'duplicate', billId: existing.billId };
    }

    const uploadId = uuidv7();
    const key = uploadKey(input.userId, uploadId);

    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: BILLS_BUCKET,
        Key: key,
        ContentType: input.mimeType,
        ContentLength: input.sizeBytes,
      }),
      { expiresIn: URL_TTL_SECONDS },
    );

    return {
      status: 'new',
      uploadId,
      url,
      expiresAt: new Date(Date.now() + URL_TTL_SECONDS * 1000).toISOString(),
      maxBytes: input.sizeBytes,
    };
  },
};
