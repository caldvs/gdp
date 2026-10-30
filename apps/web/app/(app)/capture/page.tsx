'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useUploadAndParse } from '@gdp/core/api/hooks/useUploadAndParse';
import { processImage, type ProcessedImage } from '@gdp/core/lib/image';
import { BodyText, Button, DisplayText, Mini, Notice } from '@/components/ui';
import { ParsingScan } from './ParsingScan';

type Stage = 'idle' | 'preview' | 'processing' | 'uploading-parsing';
type FriendlyError = { title: string; body?: string; code?: string };

function humanizeError(err: unknown): FriendlyError {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'PARSE_FAILED':
        return { title: "Couldn't read this one.", body: 'Try better light, or type the total.', code: err.code };
      case 'PARSE_LOW_CONFIDENCE':
        return { title: 'A few items came out fuzzy.', body: 'You can fix them on the next screen, or snap it again.', code: err.code };
      case 'IMAGE_TOO_LARGE':
        return { title: 'That photo is a heavy one.', body: 'Try a smaller image — under 10 MB.', code: err.code };
      default:
        if (err.status === 422) return { title: "Couldn't make sense of this bill.", body: err.message, code: err.code };
        if (err.status >= 500) return { title: 'Our side is grumpy.', body: "Give it another go — your photo isn't lost.", code: err.code };
        return { title: 'Something went sideways.', body: err.message, code: err.code };
    }
  }
  const message = err instanceof Error ? err.message : undefined;
  return { title: 'No signal.', body: message ?? 'Check your connection and try again.' };
}

export default function CapturePage() {
  const router = useRouter();
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [processed, setProcessed] = useState<ProcessedImage | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [stillWorking, setStillWorking] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const upload = useUploadAndParse();

  // Release the preview's object URL when it changes or we leave.
  useEffect(() => () => { if (processed) URL.revokeObjectURL(processed.uri); }, [processed]);

  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setStage('processing');
    try {
      const img = await processImage(file, file.name);
      setProcessed(img);
      setStage('preview');
    } catch (e) {
      setError(humanizeError(e));
      setStage('idle');
    }
  }, []);

  const onUse = () => {
    if (!processed) return;
    setError(null);
    setStage('uploading-parsing');
    setStillWorking(false);
    upload.mutate(processed);
  };

  const onRetake = () => {
    setStage('idle');
    setProcessed(null);
    setError(null);
    upload.reset();
  };

  useEffect(() => {
    if (stage !== 'uploading-parsing') return;
    const t = setTimeout(() => setStillWorking(true), 8_000);
    return () => clearTimeout(t);
  }, [stage]);

  useEffect(() => {
    if (upload.isSuccess && upload.data) {
      const billId = upload.data.kind === 'duplicate' ? upload.data.billId : upload.data.bill.billId;
      router.replace(`/confirm-bill/${billId}`);
    }
    if (upload.isError) {
      setError(humanizeError(upload.error));
      setStage('idle');
      setProcessed(null);
    }
  }, [upload.isSuccess, upload.isError, upload.data, upload.error, router]);

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    void handleFile(e.target.files?.[0]);
    e.target.value = '';
  };

  return (
    <div className="screen stack gap-lg">
      <div className="stack gap-sm t-center">
        {stage === 'uploading-parsing' ? (
          <>
            <DisplayText size="md">Reading your bill.</DisplayText>
            <BodyText>Usually takes a few seconds.</BodyText>
          </>
        ) : (
          <>
            <DisplayText size="md">Snap the bill.</DisplayText>
            <BodyText>Get the whole receipt in frame, nice and flat.</BodyText>
          </>
        )}
      </div>

      {error ? <Notice title={error.title} detail={error.body} /> : null}

      {/* capture="environment" opens the rear camera on phones; on desktop it's a file picker. */}
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      <input ref={libraryInput} type="file" accept="image/*,.heic,.heif" hidden onChange={pick} />

      {stage === 'idle' ? (
        <div
          className={dragOver ? 'stack gap-sm dropzone dropzone--over' : 'stack gap-sm'}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFile(e.dataTransfer.files?.[0]); }}
        >
          <Button size="lg" onClick={() => cameraInput.current?.click()}>Take a photo</Button>
          <Button variant="ghost" onClick={() => libraryInput.current?.click()}>Choose from library</Button>
          <Mini className="t-center mt-xs">or drop a photo here</Mini>
        </div>
      ) : null}

      {stage === 'preview' && processed ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={processed.uri} alt="Your bill" className="capture-preview" />
          <div className="stack gap-sm">
            <Mini className="t-center">that&apos;ll do?</Mini>
            <Button onClick={onUse}>Use this →</Button>
            <Button variant="ghost" onClick={onRetake}>Choose another</Button>
          </div>
        </>
      ) : null}

      {stage === 'processing' ? <ParsingScan phase="processing" stillWorking={false} /> : null}
      {stage === 'uploading-parsing' ? <ParsingScan phase="parsing" photoUrl={processed?.uri} stillWorking={stillWorking} /> : null}
    </div>
  );
}
