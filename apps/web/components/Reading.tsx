'use client';

/**
 * The screens shown while a bill photo is uploaded and read, and when that
 * fails. Used by the scanner (before the read starts) and by /reading/[id]
 * (while the read runs in the background), so the two look like one screen.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ActionBar, Button, Page, Steps, Title, type StepState } from './ui';
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

/** Seconds into a read at which the next stage is shown as under way (a read takes 5–20s). */
const STAGE_AT = [0, 3_000, 10_000];

/** Which reading stage is under way, `ms` after the read started. */
export function readingStage(ms: number): number {
  return STAGE_AT.filter((at) => ms >= at).length - 1;
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
 * Waiting (#174): the photo large, with a scan line moving over it, and the
 * stages ticking off underneath, so it's plain something is happening.
 * `preparing` is before the read starts (shrinking and uploading the photo).
 * The read gives no progress of its own, so its stages go by time and the
 * last one stays under way until the bill opens.
 */
export function ReadingWait({ photo, title, slow, actions, phase = 'reading', since }: {
  photo?: string;
  title: string;
  slow: boolean;
  actions: ReactNode;
  phase?: 'preparing' | 'reading';
  /** When the read started (ms), so coming back to it doesn't start the stages again. */
  since?: number;
}) {
  const elapsed = useElapsed(since);
  const at = phase === 'preparing' ? -1 : readingStage(elapsed);
  const labels = ['Photo', 'Finding the bill', 'Reading the items', 'Checking the total'];
  const steps = labels.map((label, i) => ({
    label,
    state: (i - 1 < at ? 'done' : i - 1 === at ? 'busy' : 'todo') as StepState,
  }));
  return (
    <>
      <Page>
        <div role="status" aria-live="polite">
          <Title title={title} sub={slow ? 'Long bill? Nearly there.' : undefined} />
        </div>
        <div className="scan" aria-hidden="true">
          {photo ? <img src={photo} alt="" className="scan__photo" /> : <ReceiptSketch />}
          <span className="scan__line" />
        </div>
        <div className="box"><Steps steps={steps} /></div>
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
