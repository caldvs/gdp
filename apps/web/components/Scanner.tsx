'use client';

/**
 * Snap or pick a bill photo, check it ("All in?"), upload it and start
 * reading it in the background, then hand over to /reading/[id], which
 * waits for the read. Snapping uses our own camera (Camera.tsx) where the
 * browser allows it, else the phone's camera app.
 * `useScanner()` gives a page the hidden inputs, the open() calls (which
 * must run from a tap so the browser allows the camera), any error, and
 * the screen to show until the read has started.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useStartBillRead } from '@gdp/core/api/hooks/useBillRead';
import { setPendingRead } from '@gdp/core/lib/pendingRead';
import { duplicateRoute, settledSession } from '@gdp/core/lib/duplicateRoute';
import { processImage, type ProcessedImage } from '@gdp/core/lib/image';
import { ActionBar, Button, Page, Title } from './ui';
import { Camera, hasLiveCamera } from './Camera';
import { ReadingFailed, ReadingWait, stashPhoto, useSlow } from './Reading';
import { SettledRepeat } from './SettledRepeat';
import { WEB_APP_ENV } from '@/lib/config';

export type ScanError = { title: string; body?: string };

const TOO_SLOW: ScanError = { title: 'That took too long.', body: 'Try again, or take a closer photo.' };

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
  // #94: the API crashed while reading. Not the photo's fault; locally,
  // name what broke and point at the API terminal for the rest.
  if (error.code === 'INTERNAL_ERROR') {
    const name = (error.details as { errorName?: string } | undefined)?.errorName;
    return WEB_APP_ENV === 'local'
      ? { title: 'Something went wrong on our side.', body: `${name ? `${name}. ` : ''}Check the API terminal, then try again.` }
      : { title: 'Something went wrong on our side.', body: 'Not the photo’s fault. Give it another go.' };
  }
  return humanizeScanError(new ApiError(error.code === 'PARSE_TIMEOUT' ? 504 : 422, error.code, error.message, undefined, error.details));
}

type Source = 'camera' | 'library';

export function useScanner() {
  const router = useRouter();
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  // 'camera': our own camera is open. 'checking': the photo is shown with
  // Retake and Use photo, nothing uploaded yet. 'failed': the upload or the
  // start of the read went wrong; the photo stays so it can be tried again.
  // Once the read has started, the reading page (/reading/[id]) takes over.
  const [busy, setBusy] = useState<'camera' | 'processing' | 'checking' | 'uploading' | 'failed' | null>(null);
  const [photo, setPhoto] = useState<ProcessedImage | null>(null);
  const [source, setSource] = useState<Source>('camera');
  const [error, setError] = useState<ScanError | null>(null);
  const [since, setSince] = useState<number>();
  // A photo of a bill already split and closed: Open or Start again.
  const [settled, setSettled] = useState<{ billId: string; sessionId: string } | null>(null);
  const slow = useSlow(8_000, since);
  const start = useStartBillRead();

  const handleFile = useCallback(async (file: File | undefined, from: Source = 'library') => {
    if (!file) return;
    setError(null);
    setSource(from);
    setBusy('processing');
    try {
      const img = await processImage(file, file.name);
      setPhoto(img);
      setBusy('checking');
    } catch (e) {
      setError(humanizeScanError(e));
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    if (start.isSuccess && start.data) {
      const result = start.data;
      const sessionId = result.kind === 'duplicate' ? settledSession(result.context) : undefined;
      if (result.kind === 'duplicate' && sessionId) {
        // Already split and closed: ask before going anywhere.
        dropPhoto();
        setBusy(null);
        setSettled({ billId: result.billId, sessionId });
        start.reset();
      } else if (result.kind === 'duplicate') {
        // Back to that bill: its table if it's in a session, else Review bill.
        router.replace(duplicateRoute(result.billId, result.context));
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

  // Our camera where the browser has one; the phone's camera app otherwise.
  const openCamera = () => {
    setError(null);
    if (hasLiveCamera()) setBusy('camera');
    else camera.current?.click();
  };
  const openLibrary = () => library.current?.click();
  const dropPhoto = () => {
    if (photo) URL.revokeObjectURL(photo.uri);
    setPhoto(null);
  };

  const cancel = () => { start.reset(); dropPhoto(); setBusy(null); setError(null); };
  const sendPhoto = () => {
    if (!photo) return;
    setError(null);
    setSince(Date.now());
    setBusy('uploading');
    start.mutate(photo);
  };
  const retake = () => {
    dropPhoto();
    setBusy(null);
    if (source === 'library') openLibrary();
    else openCamera();
  };
  const pickFrom = (from: Source) => (e: React.ChangeEvent<HTMLInputElement>) => {
    void handleFile(e.target.files?.[0], from);
    e.target.value = '';
  };

  const inputs: ReactNode = (
    <>
      {settled ? <SettledRepeat {...settled} onClose={() => setSettled(null)} /> : null}
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={pickFrom('camera')} aria-label="Take a photo of the bill" />
      <input ref={library} type="file" accept="image/*,.heic,.heif" hidden onChange={pickFrom('library')} aria-label="Choose a photo of the bill" />
    </>
  );

  const screen: ReactNode =
    busy === 'camera' ? (
      <Camera
        onPhoto={(file) => void handleFile(file, 'camera')}
        onClose={() => setBusy(null)}
        onLibrary={openLibrary}
        onSystemCamera={() => { setBusy(null); camera.current?.click(); }}
      />
    ) : busy === 'checking' && photo ? (
      <>
        <Page>
          <Title title="All in?" sub="Check you can see the name and the total." />
          <img src={photo.uri} alt="Your photo of the bill" className="check-photo" />
        </Page>
        <ActionBar>
          <Button tone="secondary" onClick={retake}>Retake</Button>
          <Button grow onClick={sendPhoto}>Use photo</Button>
        </ActionBar>
      </>
    ) : busy === 'failed' && photo ? (
      <ReadingFailed
        photo={photo.uri}
        error={error ?? { title: 'Couldn’t read that one.' }}
        onCancel={cancel}
        onNewPhoto={openCamera}
        onRetry={sendPhoto}
      />
    ) : busy === 'processing' || busy === 'uploading' || (start.isSuccess && start.data?.kind === 'reading') ? (
      <ReadingWait
        photo={photo?.uri}
        title={busy === 'processing' ? 'Getting your photo ready' : 'Reading your bill'}
        slow={slow}
        phase={busy === 'processing' || busy === 'uploading' ? 'preparing' : 'reading'}
        actions={<Button tone="secondary" onClick={cancel}>Cancel</Button>}
      />
    ) : null;

  return {
    /** The hidden photo inputs, and the settled-repeat sheet when it's up: render on every screen. */
    inputs,
    /** The scanner's own screen (camera, photo check, waiting, failed), or null. */
    screen,
    // Shown by the page only when there's no photo to keep (the photo itself couldn't be prepared).
    error: busy === 'failed' ? null : error,
    openCamera,
    openLibrary,
    handleFile,
  };
}
