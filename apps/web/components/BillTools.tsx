'use client';

/**
 * "QR code", "Bill photo" and "Email me" for anyone at the table. Guests
 * can pass the code on to people the host isn't sitting near, everyone can
 * check the photo of the bill against what they had, and anyone can email
 * themselves a report of the bill (the lead's lists every diner).
 */
import { startTransition, useState } from 'react';
import { useBillImageUrl } from '@gdp/core/api/hooks/useBillImageUrl';
import { useEmailReport } from '@gdp/core/api/hooks/useSession';
import { Button, Dialog, MailIcon, PhotoIcon, QrIcon, Spinner, TickIcon } from './ui';

export function BillTools({ sessionId, billId, showQr }: { sessionId: string; billId: string; showQr: boolean }) {
  const [photo, setPhoto] = useState(false);
  return (
    <>
      <div className="tools">
        {showQr ? <Button tone="secondary" small href={`/session/${sessionId}/share`}><QrIcon />QR code</Button> : null}
        <Button tone="secondary" small onClick={() => setPhoto(true)}><PhotoIcon />Bill photo</Button>
        <EmailReport sessionId={sessionId} />
      </div>
      {photo ? <BillPhoto billId={billId} onClose={() => startTransition(() => setPhoto(false))} /> : null}
    </>
  );
}

function EmailReport({ sessionId }: { sessionId: string }) {
  const report = useEmailReport(sessionId);
  const label = report.isPending ? 'Sending…' : report.isSuccess ? 'Emailed' : report.isError ? 'Try again' : 'Email me';
  return (
    <Button
      tone="secondary"
      small
      onClick={() => report.mutate()}
      disabled={report.isPending || report.isSuccess}
      aria-label={report.isSuccess ? 'Report emailed to you' : 'Email me a report of this bill'}
    >
      {report.isSuccess ? <TickIcon size={18} /> : <MailIcon />}
      <span aria-live="polite">{label}</span>
    </Button>
  );
}

function BillPhoto({ billId, onClose }: { billId: string; onClose: () => void }) {
  const img = useBillImageUrl(billId, true);
  return (
    <Dialog id="photo-t" title="Bill photo" onClose={onClose} actions={<Button tone="secondary" onClick={onClose}>Close</Button>}>
      {img.isPending ? <Spinner label="Loading the photo" /> : null}
      {img.isError ? <p className="muted">The photo isn’t available for this bill.</p> : null}
      {img.data ? (
        <a href={img.data.url} target="_blank" rel="noopener noreferrer" aria-label="Open the photo full size">
          <img src={img.data.url} alt="Photo of the bill" className="photo-full" />
        </a>
      ) : null}
    </Dialog>
  );
}
