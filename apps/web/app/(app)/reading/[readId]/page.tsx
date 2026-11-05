'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useBillRead, useRetryBillRead } from '@gdp/core/api/hooks/useBillRead';
import { clearPendingRead, getPendingRead, setPendingRead, type PendingRead } from '@gdp/core/lib/pendingRead';
import { duplicateRoute } from '@gdp/core/lib/duplicateRoute';
import { humanizeReadError, humanizeScanError, useScanner } from '@/components/Scanner';
import { ReadingFailed, ReadingWait, photoFor, stashPhoto, useSlow } from '@/components/Reading';
import { Button } from '@/components/ui';

/**
 * Waits for a background read (POST /v1/bills/reads) on R2: the photo being
 * scanned and the stages ticking off (#174), nothing else to do. When it's read, Review
 * bill opens. The place comes from the receipt alone; nothing is asked
 * (#136). The lead can go back to Bills meanwhile; the read carries on and
 * Bills' "Bill read" row comes back here. If it fails, the photo stays,
 * with Try again.
 */
export default function ReadingPage() {
  const { readId } = useParams<{ readId: string }>();
  const router = useRouter();
  const read = useBillRead(readId);
  const retry = useRetryBillRead();
  const scanner = useScanner();
  // Browser storage is read after mount: the server render has none.
  const [pending, setPending] = useState<PendingRead | null | undefined>(undefined);
  useEffect(() => setPending(getPendingRead()), [readId]);
  const mine = pending?.readId === readId ? pending : null;
  const slow = useSlow(8_000, mine?.startedAt);
  const photo = photoFor(readId);

  const billId = read.data?.status === 'done' ? read.data.billId : undefined;
  // A photo read before: back to that bill, wherever it's got to.
  const duplicate = read.data?.duplicate;
  useEffect(() => {
    if (!billId || pending === undefined) return;
    if (mine) setPendingRead({ ...mine, billId });
    router.replace(duplicateRoute(billId, duplicate));
  }, [billId, duplicate, mine, pending, router]);

  // A new photo taken from here: the scanner's own screens take over.
  if (scanner.screen) return <>{scanner.inputs}{scanner.screen}</>;

  const failed = read.data?.status === 'failed' || read.isError;
  if (failed) {
    const error = read.isError ? humanizeScanError(read.error) : humanizeReadError(read.data?.error);
    const tryAgain = mine
      ? () =>
          retry.mutate(mine.uploadId, {
            onSuccess: (next) => {
              if (photo) stashPhoto(next.readId, photo);
              setPendingRead({ readId: next.readId, uploadId: mine.uploadId, startedAt: Date.now() });
              router.replace(`/reading/${next.readId}`);
            },
          })
      : undefined;
    return (
      <>
        {scanner.inputs}
        <ReadingFailed
          photo={photo}
          error={retry.isError ? humanizeScanError(retry.error) : error}
          onCancel={() => { clearPendingRead(readId); router.replace('/'); }}
          onNewPhoto={scanner.openCamera}
          onRetry={tryAgain}
          retrying={retry.isPending}
        />
      </>
    );
  }

  return (
    <>
      {scanner.inputs}
      <ReadingWait
        photo={photo}
        title="Reading your bill"
        slow={slow}
        since={mine?.startedAt}
        actions={<Button tone="secondary" href="/">Back to bills</Button>}
      />
    </>
  );
}
