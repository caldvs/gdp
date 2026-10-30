import { useMutation } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';
import { uuidv7 } from '../../lib/idempotency';
import type { ProcessedImage } from '../../lib/image';

type UploadRequest = components['schemas']['UploadRequest'];
type UploadSlot = components['schemas']['UploadSlot'];
type UploadDuplicate = components['schemas']['UploadDuplicate'];
type Bill = components['schemas']['Bill'];

type UploadResponse = UploadSlot | UploadDuplicate;

export type UploadAndParseResult =
  | { kind: 'duplicate'; billId: string }
  | { kind: 'parsed'; bill: Bill };

export function useUploadAndParse() {
  return useMutation<UploadAndParseResult, ApiError | Error, ProcessedImage>({
    mutationFn: async (img) => {
      const slotOrDup = await api<UploadResponse>('/v1/bills/uploads', {
        method: 'POST',
        body: {
          sha256: img.sha256,
          sizeBytes: img.sizeBytes,
          mimeType: img.mimeType,
        } satisfies UploadRequest,
      });

      if (slotOrDup.status === 'duplicate') {
        return { kind: 'duplicate', billId: slotOrDup.billId };
      }

      // Raw PUT to S3 — bypass our fetcher (no auth header, no JSON body)
      const putRes = await fetch(slotOrDup.url, {
        method: 'PUT',
        headers: { 'content-type': img.mimeType },
        body: img.blob,
      });
      if (!putRes.ok) {
        throw new Error(`S3 PUT failed: ${putRes.status} ${putRes.statusText}`);
      }

      const bill = await api<Bill>('/v1/bills/parse', {
        method: 'POST',
        body: { uploadId: slotOrDup.uploadId },
        idempotencyKey: uuidv7(),
      });

      return { kind: 'parsed', bill };
    },
  });
}
