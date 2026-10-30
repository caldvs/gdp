'use client';

/**
 * Snap or pick a bill photo, upload it and start reading it in the
 * background, then hand over to /reading/[id], which waits for the read.
 * `useScanner()` gives a page the hidden inputs, the open() calls (which
 * must run from a tap so the browser allows the camera), any error, and
 * the view to show until the read has started.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useStartBillRead } from '@gdp/core/api/hooks/useBillRead';
import { setPendingRead } from '@gdp/core/lib/pendingRead';
import { processImage, type ProcessedImage } from '@gdp/core/lib/image';
import { Button } from './ui';
import { ReadingFailed, ReadingWait, stashPhoto, useSlow } from './Reading';

export type ScanError = { title: string; body?: string };

const TOO_SLOW: ScanError = { title: 'That took too long.', body: 'Try again, or take a closer photo.' };

export function humanizeScanError(err: unknown): ScanError {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'PARSE_FAILED': {
        // The API uses one code for "the model couldn't read it" and "we
        // couldn't talk to the model". Only the first is the photo's fault.
        const d = (err.details ?? {}) as { status?: number };
        // "Bedrock: ThrottlingException" etc.: the model service, not the photo.
        if (/reach Gemini|^Bedrock: /i.test(err.message)) return { title: 'Couldn’t reach the bill reader.', body: 'Not the photo’s fault. Try again.' };
        if (/Gemini returned/i.test(err.message)) {
          const why = d.status === 400 || d.status === 403 ? 'The bill reader turned us away.' : d.status === 429 ? 'The bill reader is busy.' : `The bill reader answered ${d.status ?? '?'}.`;
          return { title: 'The bill reader said no.', body: `${why} Not the photo’s fault.` };
        }
        return { title: 'Couldn’t read that one.', body: 'Try better light, or a flatter shot.' };
      }
      case 'PARSE_TIMEOUT': return TOO_SLOW;
      // Nothing could be read: the API only says this when no items came out.
      case 'PARSE_LOW_CONFIDENCE': return { title: 'Couldn’t find any items.', body: 'Try better light, or a flatter shot.' };
      case 'IMAGE_TOO_LARGE': return { title: 'That photo is too big.', body: 'Try one under 10 MB.' };
      default:
        // API Gateway gives up at 30s with a bare 503/504 and no code.
        if (err.status === 503 || err.status === 504) return TOO_SLOW;
        if (err.status >= 500) return { title: 'Something went wrong on our side.', body: 'Give it another go.' };
        return { title: 'Couldn’t make sense of this bill.', body: err.message };
    }
  }
  return { title: 'No connection.', body: 'Check your connection and try again.' };
}

/** The error a failed background read recorded, in the scanner's words. */
export function humanizeReadError(error: { code: string; message: string; details?: unknown } | undefined): ScanError {
  if (!error) return { title: 'Couldn’t read that one.', body: 'Try again, or take a new photo.' };
  return humanizeScanError(new ApiError(error.code === 'PARSE_TIMEOUT' ? 504 : 422, error.code, error.message, undefined, error.details));
}

export function useScanner() {
  const router = useRouter();
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  // 'failed': the upload or the start of the read went wrong; the photo
  // stays so it can be tried again. Once the read has started, the
  // reading page (/reading/[id]) takes over.
  const [busy, setBusy] = useState<'processing' | 'uploading' | 'failed' | null>(null);
  const [photo, setPhoto] = useState<ProcessedImage | null>(null);
  const [error, setError] = useState<ScanError | null>(null);
  const [since, setSince] = useState<number>();
  const slow = useSlow(8_000, since);
  const start = useStartBillRead();

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setSince(Date.now());
    setBusy('processing');
    try {
      const img = await processImage(file, file.name);
      setPhoto(img);
      setBusy('uploading');
      start.mutate(img);
    } catch (e) {
      setError(humanizeScanError(e));
      setBusy(null);
    }
  }, [start]);

  useEffect(() => {
    if (start.isSuccess && start.data) {
      const result = start.data;
      if (result.kind === 'duplicate') {
        router.replace(`/confirm-bill/${result.billId}`);
      } else {
        // The photo URL is handed to the reading page, so it isn't revoked here.
        if (photo) stashPhoto(result.read.readId, photo.uri);
        setPendingRead({ readId: result.read.readId, uploadId: result.uploadId, startedAt: Date.now() });
        router.push(`/reading/${result.read.readId}`);
      }
    }
    if (start.isError) {
      setError(humanizeScanError(start.error));
      setBusy('failed');
      start.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start.isSuccess, start.isError, start.data, start.error]);

  const cancel = () => { start.reset(); setPhoto(null); setBusy(null); setError(null); };
  const retry = () => {
    if (!photo) return;
    setError(null);
    setBusy('uploading');
    start.mutate(photo);
  };
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => { void handleFile(e.target.files?.[0]); e.target.value = ''; };

  const inputs: ReactNode = (
    <>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={pick} aria-label="Take a photo of the bill" />
      <input ref={library} type="file" accept="image/*,.heic,.heif" hidden onChange={pick} aria-label="Choose a photo of the bill" />
    </>
  );

  const reading: ReactNode =
    busy === 'failed' && photo ? (
      <ReadingFailed
        photo={photo.uri}
        error={error ?? { title: 'Couldn’t read that one.' }}
        onCancel={cancel}
        onNewPhoto={() => camera.current?.click()}
        onRetry={retry}
      />
    ) : busy === 'processing' || busy === 'uploading' || (start.isSuccess && start.data?.kind === 'reading') ? (
      <ReadingWait
        photo={photo?.uri}
        title={busy === 'processing' ? 'Getting your photo ready' : 'Reading your bill'}
        slow={slow}
        actions={<Button tone="secondary" onClick={cancel}>Cancel</Button>}
      />
    ) : null;

  return {
    inputs,
    reading,
    // Shown by the page only when there's no photo to keep (the photo itself couldn't be prepared).
    error: busy === 'failed' ? null : error,
    openCamera: () => camera.current?.click(),
    openLibrary: () => library.current?.click(),
    handleFile,
  };
}
