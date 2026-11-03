'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useBill } from '@gdp/core/api/hooks/useBill';
import { useBillRead, useRetryBillRead } from '@gdp/core/api/hooks/useBillRead';
import { formatGBP } from '@gdp/core/lib/money';
import { clearPendingRead, getPendingRead, setPendingRead, type PendingRead } from '@gdp/core/lib/pendingRead';
import { answersForUpload, attachAnswersToBill, saveAnswers, type ScanVenue } from '@gdp/core/lib/scanAnswers';
import { humanizeReadError, humanizeScanError, useScanner } from '@/components/Scanner';
import { ReadingFailed, ReadingWait, Thumb, photoFor, stashPhoto, useSlow } from '@/components/Reading';
import { HowManyOfYou, PARTY_DEFAULT, WhereAreYou } from '@/components/ScanQuestions';
import { ActionBar, Button, Page, Title } from '@/components/ui';

type Answers = { venue?: ScanVenue; expectedDiners?: number };

/**
 * Waits for a background read (POST /v1/bills/reads). Meanwhile the lead
 * says how many are eating (2 unless they change it); once it's read, the
 * place on the receipt is shown, and asked for only when there was none
 * (#61, #135). Answers are kept in this browser and used once the bill is
 * ready (scanAnswers.ts). Bills' "Bill read" row comes back here.
 * *Review bill* opens when the read is done. The lead can go back to Bills
 * meanwhile; the read carries on and Bills shows it. If it fails, the
 * photo stays with Try again, and so do the answers.
 */
export default function ReadingPage() {
  const { readId } = useParams<{ readId: string }>();
  const router = useRouter();
  const read = useBillRead(readId);
  const retry = useRetryBillRead();
  const scanner = useScanner();
  // Browser storage is read after mount: the server render has none.
  // `undefined` until it's been read: coming back from Bills, the finished
  // read is already cached, and must not send this browser on to Review
  // bill before it knows it's the one that asked (#135).
  const [pending, setPending] = useState<PendingRead | null | undefined>(undefined);
  useEffect(() => setPending(getPendingRead()), [readId]);
  const mine = pending?.readId === readId ? pending : null;
  const knowsPending = pending !== undefined;
  const slow = useSlow(8_000, mine?.startedAt);
  const photo = photoFor(readId);

  const billId = read.data?.status === 'done' ? read.data.billId : undefined;
  // The answers are kept by upload, so only the browser that started the
  // read asks; anywhere else (no pending read) it opens the bill when ready.
  const [answers, setAnswers] = useState<Answers | null>(null);
  const uploadId = mine?.uploadId;
  useEffect(() => {
    if (!uploadId) return;
    const a = answersForUpload(uploadId);
    setAnswers({ ...(a?.venue ? { venue: a.venue } : {}), expectedDiners: a?.expectedDiners ?? PARTY_DEFAULT });
    // The party size starts at 2: kept so the table gets it even if untouched.
    if (a?.expectedDiners === undefined) saveAnswers(uploadId, { expectedDiners: PARTY_DEFAULT });
  }, [uploadId]);
  const answer = (patch: { venue?: ScanVenue | null; expectedDiners?: number | null }) => {
    if (!uploadId) return;
    saveAnswers(uploadId, patch);
    // Answered after the read finished: these belong to its bill already.
    if (billId) attachAnswersToBill(uploadId, billId);
    setAnswers((prev) => {
      const next = { ...prev };
      if (patch.venue !== undefined) { if (patch.venue) next.venue = patch.venue; else delete next.venue; }
      if (patch.expectedDiners !== undefined) { if (patch.expectedDiners === null) delete next.expectedDiners; else next.expectedDiners = patch.expectedDiners; }
      return next;
    });
  };

  const bill = useBill(billId);
  useEffect(() => {
    if (!billId || !knowsPending) return;
    if (mine) {
      setPendingRead({ ...mine, billId });
      attachAnswersToBill(mine.uploadId, billId);
    } else {
      router.replace(`/confirm-bill/${billId}`);
    }
  }, [billId, mine, knowsPending, router]);

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

  if (!mine || !answers) {
    return (
      <>
        {scanner.inputs}
        <ReadingWait
          photo={photo}
          title="Reading your bill"
          slow={slow}
          actions={<Button tone="secondary" href="/">Back to bills</Button>}
        />
      </>
    );
  }

  const b = bill.data;
  const n = b?.items.length ?? 0;
  return (
    <>
      {scanner.inputs}
      <Page>
        <div className="reading-head">
          <Thumb uri={photo} />
          <div role="status" aria-live="polite">
            {billId ? (
              <Title
                title={<><span className="reading-done" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg></span>Bill read</>}
                sub={b ? `${n} ${n === 1 ? 'item' : 'items'} · ${formatGBP(b.totalPence)}` : '\u00a0'}
              />
            ) : (
              <Title title="Reading your bill" sub={slow ? 'Long bill? Nearly there.' : 'Usually a few seconds.'} />
            )}
          </div>
        </div>
        <WhereAreYou
          venue={answers.venue}
          found={b ? (b.venue?.name ? { name: b.venue.name, ...(b.venue.address ? { address: b.venue.address } : {}) } : null) : undefined}
          onChange={(venue) => answer({ venue })}
        />
        <HowManyOfYou n={answers.expectedDiners} onChange={(expectedDiners) => answer({ expectedDiners })} />
      </Page>
      <ActionBar>
        <Button tone="secondary" href="/">Back to bills</Button>
        <Button grow disabled={!billId} onClick={() => billId && router.replace(`/confirm-bill/${billId}`)}>
          {billId ? 'Review bill' : 'Reading…'}
        </Button>
      </ActionBar>
    </>
  );
}
