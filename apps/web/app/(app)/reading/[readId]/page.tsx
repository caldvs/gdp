'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useBillRead, useRetryBillRead } from '@gdp/core/api/hooks/useBillRead';
import { clearPendingRead, getPendingRead, setPendingRead, type PendingRead } from '@gdp/core/lib/pendingRead';
import { duplicateRoute, settledSession } from '@gdp/core/lib/duplicateRoute';
import { humanizeReadError, humanizeScanError, useScanner } from '@/components/Scanner';
import { ReadingFailed, ReadingWait, photoFor, stashPhoto, useSlow } from '@/components/Reading';
import { useBill } from '@gdp/core/api/hooks/useBill';
import type { components } from '@gdp/core/api';
import { formatGBP } from '@gdp/core/lib/money';
import { ActionBar, Button, Page, Receipt, ReceiptLine, Title } from '@/components/ui';
import { SettledRepeat } from '@/components/SettledRepeat';

/**
 * Waits for a background read (POST /v1/bills/reads) on R2: the photo being
 * scanned and the stages ticking off (#174), nothing else to do. Once read, a new
 * bill prints onto a receipt (L2.1) and *Proceed* opens Check it matches; a photo
 * read before goes straight back to its bill. The place comes from the receipt alone; nothing is asked
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
  // Already split and closed: Open or Start again first.
  const settled = settledSession(duplicate);
  // A new bill shows its lines here first (L2.1), then *Proceed*. A photo
  // read before goes straight back to its bill.
  const fresh = !!billId && !duplicate;
  const bill = useBill(fresh ? billId : undefined);
  useEffect(() => {
    if (!billId || pending === undefined) return;
    if (mine) setPendingRead({ ...mine, billId });
    if (!settled && duplicate) router.replace(duplicateRoute(billId, duplicate));
  }, [billId, duplicate, mine, pending, router, settled]);

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

  if (fresh && bill.data) {
    return <ReadBill bill={bill.data} onProceed={() => router.replace(duplicateRoute(billId!))} />;
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
      {billId && settled ? (
        <SettledRepeat billId={billId} sessionId={settled} onClose={() => { clearPendingRead(readId); router.replace('/'); }} />
      ) : null}
    </>
  );
}

type Bill = components['schemas']['Bill'];

/**
 * L2.1 (#223): the bill's lines arrive together, but they print onto the
 * receipt one by one, about 2.5s in all (at once with reduced motion). Then
 * *Proceed* to Check it matches. No progress bar (decided).
 */
function ReadBill({ bill, onProceed }: { bill: Bill; onProceed: () => void }) {
  const lines = [
    ...bill.items.map((it) => ({ key: it.itemId, name: it.quantity > 1 ? `${it.quantity} × ${it.name}` : it.name, pence: it.unitPricePence * it.quantity, quiet: false })),
    ...(bill.serviceChargePence > 0 ? [{ key: 'service', name: 'Service', pence: bill.serviceChargePence, quiet: true }] : []),
    ...(bill.taxPence > 0 ? [{ key: 'tax', name: 'Tax', pence: bill.taxPence, quiet: true }] : []),
  ];
  const all = lines.length + 1;
  const [shown, setShown] = useState(() => (reducedMotion() ? all : 0));
  useEffect(() => {
    if (shown >= all) return;
    const t = setTimeout(() => setShown((n) => n + 1), Math.round(2500 / all));
    return () => clearTimeout(t);
  }, [shown, all]);
  const done = shown >= all;
  return (
    <>
      <Page>
        <Title title="Here’s your bill" sub={<span role="status">{done ? 'Every line read.' : 'Reading the prices…'}</span>} />
        <Receipt label="The bill" head={bill.venue?.name ?? 'Your bill'}>
          {lines.map((l, i) => (
            <div key={l.key} className={`read-line${i < shown ? ' read-line--in' : ''}`} aria-hidden={i < shown ? undefined : true}>
              <ReceiptLine quiet={l.quiet} name={l.name} price={(l.pence / 100).toFixed(2)} />
            </div>
          ))}
          <div className={`read-line${done ? ' read-line--in' : ''}`} aria-hidden={done ? undefined : true}>
            <ReceiptLine strong name="Total" price={<span className="receipt__total">{formatGBP(bill.totalPence)}</span>} />
          </div>
        </Receipt>
      </Page>
      <ActionBar stack>
        <Button onClick={onProceed}>Proceed</Button>
        <Button tone="secondary" href="/">Back to bills</Button>
      </ActionBar>
    </>
  );
}

function reducedMotion(): boolean {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}
