'use client';

/**
 * QR code, bill photo and email-me, as a row of icons beside the bill's
 * title (#177: the claiming list is the point of the screen, so these stay
 * small). For anyone at the table. Guests
 * can pass the code on to people the host isn't sitting near, everyone can
 * check the photo of the bill against what they had, and anyone can email
 * themselves a report of the bill (the lead's lists every diner).
 */
import Link from 'next/link';
import { startTransition, useState } from 'react';
import { useBillImageUrl } from '@gdp/core/api/hooks/useBillImageUrl';
import { useEmailReport } from '@gdp/core/api/hooks/useSession';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { Button, Dialog, MailIcon, PhotoIcon, QrIcon, Spinner, TickIcon } from './ui';

export function BillTools({ sessionId, billId, showQr }: { sessionId: string; billId: string; showQr: boolean }) {
  const [photo, setPhoto] = useState(false);
  // Guests (#183) have no email address to send a report to.
  const canEmail = !useMe().data?.guestSessionId;
  return (
    <>
      <div className="tools">
        {showQr ? <Link className="tool" href={`/session/${sessionId}/share`} aria-label="QR code" title="QR code"><QrIcon /></Link> : null}
        <button type="button" className="tool" onClick={() => setPhoto(true)} aria-label="Bill photo" title="Bill photo"><PhotoIcon /></button>
        {canEmail ? <EmailReport sessionId={sessionId} /> : null}
      </div>
      {photo ? <BillPhoto billId={billId} onClose={() => startTransition(() => setPhoto(false))} /> : null}
    </>
  );
}

function EmailReport({ sessionId }: { sessionId: string }) {
  const report = useEmailReport(sessionId);
  const label = report.isPending ? 'Sending…' : report.isSuccess ? 'Emailed' : report.isError ? 'Try again' : 'Email me';
  return (
    <button
      type="button"
      className="tool"
      onClick={() => report.mutate()}
      disabled={report.isPending || report.isSuccess}
      aria-label={report.isSuccess ? 'Report emailed to you' : 'Email me a report of this bill'}
      title={label}
    >
      {report.isPending ? <span className="spin" aria-hidden /> : report.isSuccess ? <TickIcon size={18} /> : <MailIcon />}
      <span className="vh" aria-live="polite">{label}</span>
    </button>
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
