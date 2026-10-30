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

function Thumb({ uri }: { uri?: string }) {
  return uri
    ? <img src={uri} alt="Your bill" className="reading-thumb" />
    : <span className="skel reading-thumb" aria-hidden="true" />;
}

/** Waiting: the photo beside the title, grey bill rows below. */
export function ReadingWait({ photo, title, slow, actions }: {
  photo?: string;
  title: string;
  slow: boolean;
  actions: ReactNode;
}) {
  return (
    <>
      <Page>
        <div className="reading-head">
          <Thumb uri={photo} />
          <div role="status" aria-live="polite">
            <Title title={title} sub={slow ? 'Long bill? Nearly there.' : 'Usually a few seconds.'} />
          </div>
        </div>
        <BillSkeleton />
      </Page>
      <ActionBar>{actions}</ActionBar>
    </>
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
