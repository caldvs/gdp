'use client';

/**
 * Beside the bill's title (#177: the claiming list is the point of the
 * screen, so these stay small): the QR code, for anyone who can pass it on,
 * and "⋯" for the rest, as a sheet with words rather than more bare icons:
 * the photo of the bill, to check it against what they had, and emailing
 * themselves a report of the bill (the lead's lists every diner).
 */
import Link from 'next/link';
import { startTransition, useState } from 'react';
import { useBillImageUrl } from '@gdp/core/api/hooks/useBillImageUrl';
import { useEmailReport } from '@gdp/core/api/hooks/useSession';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { Box, Button, Dialog, MoreIcon, QrIcon, RowButton, Spinner } from './ui';

/** `onDelete`: the lead's *Delete this bill*, kept in the sheet, away from the main buttons. */
export function BillTools({ sessionId, billId, showQr, onDelete }: { sessionId: string; billId: string; showQr: boolean; onDelete?: () => void }) {
  const [open, setOpen] = useState<null | 'more' | 'photo'>(null);
  // Guests (#183) have no email address to send a report to.
  const canEmail = !useMe().data?.guestSessionId;
  const close = () => startTransition(() => setOpen(null));
  return (
    <>
      <div className="tools">
        {showQr ? <Link className="tool" href={`/session/${sessionId}/share`} aria-label="QR code" title="QR code"><QrIcon /></Link> : null}
        <button type="button" className="tool" onClick={() => setOpen('more')} aria-label="More" aria-haspopup="dialog" title="More"><MoreIcon /></button>
      </div>
      {open === 'more' ? (
        <Dialog id="more-t" title="This bill" onClose={close} actions={<Button tone="secondary" onClick={close}>Close</Button>}>
          <Box list>
            <RowButton title="Bill photo" chevron onClick={() => setOpen('photo')} />
            {canEmail ? <EmailReport sessionId={sessionId} /> : null}
          </Box>
          {onDelete ? (
            <Button tone="text" className="btn--text-danger" onClick={() => { setOpen(null); onDelete(); }} style={{ alignSelf: 'flex-start', width: 'auto', padding: 0 }}>Delete this bill</Button>
          ) : null}
        </Dialog>
      ) : null}
      {open === 'photo' ? <BillPhoto billId={billId} onClose={close} /> : null}
    </>
  );
}

function EmailReport({ sessionId }: { sessionId: string }) {
  const report = useEmailReport(sessionId);
  const sub = report.isPending ? 'Sending…' : report.isSuccess ? 'Sent. Check your inbox.' : report.isError ? 'Didn’t send. Try again.' : undefined;
  return (
    <>
      <RowButton
        title="Email me a report"
        sub={sub}
        onClick={() => report.mutate()}
        disabled={report.isPending || report.isSuccess}
        label={report.isSuccess ? 'Report emailed to you' : 'Email me a report of this bill'}
      />
      <span className="vh" aria-live="polite">{sub}</span>
    </>
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
