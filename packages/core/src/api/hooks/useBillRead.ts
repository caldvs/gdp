import { useMutation, useQuery } from '@tanstack/react-query';
import { api, ApiError, type components } from '../index';
import { uuidv7 } from '../../lib/idempotency';
import type { ProcessedImage } from '../../lib/image';

type UploadRequest = components['schemas']['UploadRequest'];
type UploadSlot = components['schemas']['UploadSlot'];
type UploadDuplicate = components['schemas']['UploadDuplicate'];
export type BillRead = components['schemas']['BillRead'];

export type StartReadResult =
  /** This photo was read before: open that bill. */
  | { kind: 'duplicate'; billId: string }
  /** Reading in the background: poll `useBillRead(read.readId)`. */
  | { kind: 'reading'; read: BillRead; uploadId: string };

/** Starts a background read of an upload that's already in S3. */
export const startRead = (uploadId: string) =>
  api<BillRead>('/v1/bills/reads', {
    method: 'POST',
    body: { uploadId },
    idempotencyKey: uuidv7(),
  });

/** Uploads the photo, then starts reading it in the background. */
export function useStartBillRead() {
  return useMutation<StartReadResult, ApiError | Error, ProcessedImage>({
    mutationFn: async (img) => {
      const slotOrDup = await api<UploadSlot | UploadDuplicate>('/v1/bills/uploads', {
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

      const read = await startRead(slotOrDup.uploadId);
      return { kind: 'reading', read, uploadId: slotOrDup.uploadId };
    },
  });
}

/** Starts another read of the same upload (Try again): no second upload. */
export function useRetryBillRead() {
  return useMutation<BillRead, ApiError, string>({ mutationFn: startRead });
}

/** Polls a background read every 1.5s until it's done or failed. */
export function useBillRead(readId: string | undefined) {
  return useQuery<BillRead, ApiError>({
    queryKey: ['billRead', readId],
    enabled: !!readId,
    queryFn: () => api<BillRead>(`/v1/bills/reads/${readId}`),
    refetchInterval: (query) => (query.state.data?.status === 'reading' ? 1500 : false),
    retry: 2,
  });
}
