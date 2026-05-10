import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3, BILLS_BUCKET } from '../../storage/s3.js';
import { uploadKey } from './uploadService.js';

const IMAGE_URL_TTL_SECONDS = 300;

export const imageService = {
  async getImageUrl(input: {
    creatorUserId: string;
    uploadId: string;
  }): Promise<{ url: string; expiresAt: string }> {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: BILLS_BUCKET,
        Key: uploadKey(input.creatorUserId, input.uploadId),
      }),
      { expiresIn: IMAGE_URL_TTL_SECONDS },
    );
    return {
      url,
      expiresAt: new Date(Date.now() + IMAGE_URL_TTL_SECONDS * 1000).toISOString(),
    };
  },
};
