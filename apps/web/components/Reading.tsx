'use client';

/**
 * The screens shown while a bill photo is uploaded and read, and when that
 * fails. Used by the scanner (before the read starts) and by /reading/[id]
 * (while the read runs in the background), so the two look like one screen.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ActionBar, BillSkeleton, Button, Page, Title } from './ui';
import type { ScanError } from './Scanner';

/** Photo URLs by read id, so /reading/[id] can show the photo the scanner just took. */
const photos = new Map<string, string>();

export function stashPhoto(readId: string, uri: string): void {
  photos.set(readId, uri);
}
export function photoFor(readId: string): string | undefined {
  return photos.get(readId);
}

/** True once `ms` has passed since this mounted (or since `since`). */
export function useSlow(ms: number, since?: number): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const left = since === undefined ? ms : Math.max(0, since + ms - Date.now());
    const t = setTimeout(() => setSlow(true), left);
    return () => clearTimeout(t);
  }, [ms, since]);
  return slow;
}

export function Thumb({ uri }: { uri?: string }) {
  return uri
    ? <img src={uri} alt="Your bill" className="reading-thumb" />
    : <span className="skel reading-thumb" aria-hidden="true" />;
}

/**
 * What the read is doing, by time: it reports no progress of its own, and
 * takes 5–20s (#174, #185). The last line stays up until the bill opens.
 */
const STATUS: [number, string][] = [
  [0, 'Finding the items'],
  [4_000, 'Reading the prices'],
  [9_000, 'Adding it all up'],
  [13_000, 'Long bill. Nearly there'],
];

/** The status line `ms` into a read. */
export function readingStatus(ms: number): string {
  return STATUS.filter(([at]) => ms >= at).at(-1)![1];
}

/** Re-renders every half second, from `since` (or mount). */
function useElapsed(since?: number): number {
  const [start] = useState(() => since ?? Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, now - (since ?? start));
}

/**
 * Waiting (#174, #185): the photo with a scan line going over it, a status
 * line and a bar that keep moving for up to 15s, and the bill as grey rows
 * underneath. `preparing` is before the read starts (shrinking and
 * uploading the photo).
 */
export function ReadingWait({ photo, title, slow, actions, phase = 'reading', since }: {
  photo?: string;
  title: string;
  slow: boolean;
  actions: ReactNode;
  phase?: 'preparing' | 'reading';
  /** When the read started (ms), so coming back to it doesn't start again. */
  since?: number;
}) {
  const elapsed = useElapsed(since);
  const preparing = phase === 'preparing';
  const status = preparing ? 'Sending your photo' : readingStatus(elapsed);
  return (
    <>
      <Page>
        <div className="reading-hero">
          <div className="scan" aria-hidden="true">
            {photo ? <img src={photo} alt="" className="scan__photo" /> : <ReceiptSketch />}
            <span className="scan__line" />
          </div>
          <div className="reading-hero__text">
            <h1 className="reading-hero__h">{title}</h1>
            <p className="reading-hero__status" role="status" aria-live="polite"><span key={status} className="reading-hero__msg">{status}</span></p>
          </div>
        </div>
        <BillSkeleton rows={5} />
        <p className="small muted reading-hint">Up to 15 seconds.</p>
      </Page>
      <ActionBar>{actions}</ActionBar>
    </>
  );
}

/** No photo to hand (came back from Bills): a plain receipt shape instead. */
function ReceiptSketch() {
  return (
    <span className="scan__sketch">
      {[60, 40, 82, 70, 76, 58, 66, 48].map((w, i) => <span key={i} className="skel" style={{ width: `${w}%` }} />)}
    </span>
  );
}

/** It went wrong: the photo stays, with the reason and what to do next. */
export function ReadingFailed({ photo, error, onCancel, onNewPhoto, onRetry, retrying }: {
  photo?: string;
  error: ScanError;
  onCancel: () => void;
  onNewPhoto: () => void;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <>
      <Page>
        <div className="reading-head">
          <Thumb uri={photo} />
          <div role="alert">
            <Title title={error.title} sub={error.body} />
          </div>
        </div>
        <Button tone="text" onClick={onCancel}>Cancel</Button>
      </Page>
      <ActionBar>
        {onRetry ? (
          <>
            <Button tone="secondary" onClick={onNewPhoto}>New photo</Button>
            <Button grow busy={retrying} onClick={onRetry}>Try again</Button>
          </>
        ) : (
          <Button grow onClick={onNewPhoto}>New photo</Button>
        )}
      </ActionBar>
    </>
  );
}
