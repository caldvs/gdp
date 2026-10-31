'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useMySessions, type SessionSummary } from '@gdp/core/api/hooks/useMySessions';
import { useUploadAndParse } from '@gdp/core/api/hooks/useUploadAndParse';
import { processImage, type ProcessedImage } from '@gdp/core/lib/image';
import { Backdrop, BillsIcon, Btn, Close, Fab, LibraryIcon, Notice, QrIcon, Screen, Sheet, Spin, TopBar } from '@/components/glass';

type Stage = 'camera' | 'processing' | 'reading';
type FriendlyError = { title: string; body?: string };

function humanizeError(err: unknown): FriendlyError {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'PARSE_FAILED': {
        // The API uses one code for "the model couldn't read it" and "we
        // couldn't talk to the model". Only the first is the photo's fault.
        const d = (err.details ?? {}) as { status?: number; body?: string };
        if (/reach Gemini/i.test(err.message)) return { title: 'Couldn’t reach the bill reader.', body: 'Is the API online? Check its terminal.' };
        if (/Gemini returned/i.test(err.message)) {
          const why = d.status === 400 || d.status === 403 ? 'The Gemini API key was rejected.' : d.status === 429 ? 'Gemini is rate-limiting us.' : `Gemini answered ${d.status ?? '?'}.`;
          return { title: 'The bill reader said no.', body: `${why} Not the photo’s fault.` };
        }
        return { title: 'Couldn’t read that one.', body: 'Try better light, or a flatter shot.' };
      }
      case 'PARSE_LOW_CONFIDENCE': return { title: 'A few lines came out fuzzy.', body: 'You can fix them on the next screen.' };
      case 'IMAGE_TOO_LARGE': return { title: 'That photo is too big.', body: 'Try one under 10 MB.' };
      default:
        if (err.status >= 500) return { title: 'Our side hiccuped.', body: 'Give it another go.' };
        return { title: "Couldn't make sense of this bill.", body: err.message };
    }
  }
  return { title: 'No signal.', body: 'Check your connection and try again.' };
}

/** The lead's home: a camera with open bills in a tray beneath it. */
export default function CameraPage() {
  const router = useRouter();
  const cameraInput = useRef<HTMLInputElement>(null);
  const libraryInput = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage>('camera');
  const [photo, setPhoto] = useState<ProcessedImage | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [slow, setSlow] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const upload = useUploadAndParse();
  const sessions = useMySessions(10);

  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.uri); }, [photo]);

  // Snap → process → upload and parse, with no preview step in between:
  // the lead checks the items on the next screen, with the photo behind.
  const handleFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setStage('processing');
    try {
      const img = await processImage(file, file.name);
      setPhoto(img);
      setStage('reading');
      setSlow(false);
      upload.mutate(img);
    } catch (e) {
      setError(humanizeError(e));
      setStage('camera');
    }
  }, [upload]);

  useEffect(() => {
    if (stage !== 'reading') return;
    const t = setTimeout(() => setSlow(true), 8_000);
    return () => clearTimeout(t);
  }, [stage]);

  useEffect(() => {
    if (upload.isSuccess && upload.data) {
      const billId = upload.data.kind === 'duplicate' ? upload.data.billId : upload.data.bill.billId;
      router.replace(`/confirm-bill/${billId}`);
    }
    if (upload.isError) {
      setError(humanizeError(upload.error));
      setStage('camera');
      setPhoto(null);
      upload.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upload.isSuccess, upload.isError, upload.data, upload.error]);

  const retake = () => {
    upload.reset();
    setPhoto(null);
    setStage('camera');
  };

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    void handleFile(e.target.files?.[0]);
    e.target.value = '';
  };

  const open = (sessions.data?.sessions ?? []).filter((s) => isOpen(s.status)).slice(0, 2);

  if (stage !== 'camera') {
    return (
      <Screen>
        <Backdrop src={photo?.uri} tone="dim" />
        {stage === 'reading' ? <div className="g-sheen" aria-hidden /> : null}
        <TopBar
          left={<Fab label="Cancel" icon={<Close />} onClick={retake} />}
          right={<Fab label="Retake" onClick={retake}>Retake</Fab>}
        />
        <Sheet>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '4px 0 8px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 16, fontWeight: 600 }}>
              <Spin />
              {stage === 'processing' ? 'Getting your photo ready' : 'Reading your bill'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--g-mute)' }}>{slow ? 'Long bill? Nearly there' : 'Usually a few seconds'}</div>
          </div>
        </Sheet>
      </Screen>
    );
  }

  return (
    <Screen className={dragOver ? 'g-dropzone--over' : undefined}>
      <Backdrop tone="deep" />
      <input ref={cameraInput} type="file" accept="image/*" capture="environment" hidden onChange={pick} />
      <input ref={libraryInput} type="file" accept="image/*,.heic,.heif" hidden onChange={pick} />

      <TopBar
        left={<Fab href="/account" label="Your bills and account" icon={<BillsIcon />} />}
        title="Group Dine Pay"
        right={<Fab href="/join" label="Join with a code" icon={<QrIcon />} />}
      />

      <div
        className="g-viewfinder"
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); void handleFile(e.dataTransfer.files?.[0]); }}
      >
        <div className="g-viewfinder__frame" aria-hidden>
          <span className="g-viewfinder__corner g-viewfinder__corner--tl" />
          <span className="g-viewfinder__corner g-viewfinder__corner--tr" />
          <span className="g-viewfinder__corner g-viewfinder__corner--bl" />
          <span className="g-viewfinder__corner g-viewfinder__corner--br" />
        </div>
        {error ? (
          <div style={{ position: 'absolute', left: 16, right: 16, top: 90 }}>
            <Notice error title={error.title}>{error.body}</Notice>
          </div>
        ) : null}
        <div className="g-viewfinder__hint"><span>Whole bill in frame</span></div>
        <div className="g-shutter-row">
          <button type="button" className="g-library" aria-label="Choose from library" onClick={() => libraryInput.current?.click()}><LibraryIcon /></button>
          <button type="button" className="g-shutter" aria-label="Take the photo" onClick={() => cameraInput.current?.click()} />
          <span style={{ width: 48 }} aria-hidden />
        </div>
      </div>

      {open.length > 0 ? (
        <div className="g-tray">
          {open.map((s) => (
            <Link key={s.sessionId} href={`/session/${s.sessionId}`} className="g-tray__card">
              <span className="g-tray__dot" aria-hidden />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="g-tray__t" style={{ display: 'block' }}>{titleFor(s)}</span>
                <span className="g-tray__s" style={{ display: 'block' }}>{subFor(s)}</span>
              </span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            </Link>
          ))}
        </div>
      ) : (
        <div className="g-tray" style={{ pointerEvents: 'none' }}>
          <Btn tone="ghost" size="sm" style={{ visibility: 'hidden' }}>spacer</Btn>
        </div>
      )}
    </Screen>
  );
}

function isOpen(status: SessionSummary['status']): boolean {
  return status === 'claiming' || status === 'paying' || status === 'setup';
}
function titleFor(s: SessionSummary): string {
  return s.venue?.name ?? (s.role === 'lead' ? 'Your bill' : 'A bill you joined');
}
function subFor(s: SessionSummary): string {
  const when = formatWhen(s.createdAt);
  if (s.role !== 'lead') return `${when} · you owe ${s.myOwedPence !== undefined ? `£${(s.myOwedPence / 100).toFixed(2)}` : 'your share'}`;
  return `${when} · ${s.status === 'setup' ? 'not shared yet' : 'collecting'}`;
}
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'long' });
}
