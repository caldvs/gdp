'use client';

/**
 * Snap or pick a bill photo, upload and parse it, then go to Review.
 * `useScanner()` gives a page the hidden inputs, the open() calls (which
 * must run from a tap so the browser allows the camera), any error, and
 * the reading view to show while the bill is read.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useUploadAndParse } from '@gdp/core/api/hooks/useUploadAndParse';
import { processImage, type ProcessedImage } from '@gdp/core/lib/image';
import { ActionBar, BillSkeleton, Button, Page, Title } from './ui';

export type ScanError = { title: string; body?: string };

export function humanizeScanError(err: unknown): ScanError {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'PARSE_FAILED': {
        // The API uses one code for "the model couldn't read it" and "we
        // couldn't talk to the model". Only the first is the photo's fault.
        const d = (err.details ?? {}) as { status?: number };
        // Bedrock call failures read `Bedrock: <ErrorName>`, with the HTTP
        // status in details when Bedrock answered at all.
        const callFailed = /^Bedrock: /.test(err.message);
        if (callFailed && d.status === undefined) return { title: 'Couldn’t reach the bill reader.', body: 'Is the API online? Check its terminal.' };
        if (callFailed) {
          const why = d.status === 400 || d.status === 403 ? 'The bill reader turned us away.' : d.status === 429 ? 'The bill reader is busy.' : `The bill reader answered ${d.status ?? '?'}.`;
          return { title: 'The bill reader said no.', body: `${why} Not the photo’s fault.` };
        }
        return { title: 'Couldn’t read that one.', body: 'Try better light, or a flatter shot.' };
      }
      case 'PARSE_LOW_CONFIDENCE': return { title: 'A few lines came out fuzzy.', body: 'You can fix them on the next screen.' };
      case 'IMAGE_TOO_LARGE': return { title: 'That photo is too big.', body: 'Try one under 10 MB.' };
      default:
        if (err.status >= 500) return { title: 'Something went wrong on our side.', body: 'Give it another go.' };
        return { title: 'Couldn’t make sense of this bill.', body: err.message };
    }
  }
  return { title: 'No connection.', body: 'Check your connection and try again.' };
}

export function useScanner() {
  const router = useRouter();
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'processing' | 'reading' | null>(null);
  const [photo, setPhoto] = useState<ProcessedImage | null>(null);
  const [error, setError] = useState<ScanError | null>(null);
  const [slow, setSlow] = useState(false);
  const upload = useUploadAndParse();

  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.uri); }, [photo]);

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy('processing');
    try {
      const img = await processImage(file, file.name);
      setPhoto(img);
      setBusy('reading');
      setSlow(false);
      upload.mutate(img);
    } catch (e) {
      setError(humanizeScanError(e));
      setBusy(null);
    }
  }, [upload]);

  useEffect(() => {
    if (busy !== 'reading') return;
    const t = setTimeout(() => setSlow(true), 8_000);
    return () => clearTimeout(t);
  }, [busy]);

  useEffect(() => {
    if (upload.isSuccess && upload.data) {
      const billId = upload.data.kind === 'duplicate' ? upload.data.billId : upload.data.bill.billId;
      router.replace(`/confirm-bill/${billId}`);
    }
    if (upload.isError) {
      setError(humanizeScanError(upload.error));
      setBusy(null);
      setPhoto(null);
      upload.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upload.isSuccess, upload.isError, upload.data, upload.error]);

  const cancel = () => { upload.reset(); setPhoto(null); setBusy(null); };
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => { void handleFile(e.target.files?.[0]); e.target.value = ''; };

  const inputs: ReactNode = (
    <>
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={pick} aria-label="Take a photo of the bill" />
      <input ref={library} type="file" accept="image/*,.heic,.heif" hidden onChange={pick} aria-label="Choose a photo of the bill" />
    </>
  );

  const reading: ReactNode = busy ? (
    <>
      <Page>
        <div className="reading-head">
          {photo ? <img src={photo.uri} alt="Your bill" className="reading-thumb" /> : <span className="skel reading-thumb" aria-hidden="true" />}
          <div role="status" aria-live="polite">
            <Title title={busy === 'processing' ? 'Getting your photo ready' : 'Reading your bill'} sub={slow ? 'Long bill? Nearly there.' : 'Usually a few seconds.'} />
          </div>
        </div>
        <BillSkeleton />
      </Page>
      <ActionBar><Button tone="secondary" onClick={cancel}>Cancel</Button></ActionBar>
    </>
  ) : null;

  return {
    inputs,
    reading,
    error,
    openCamera: () => camera.current?.click(),
    openLibrary: () => library.current?.click(),
    handleFile,
  };
}
