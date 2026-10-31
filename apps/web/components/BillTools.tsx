'use client';

/**
 * "QR code" and "Bill photo" for anyone at the table. Guests can pass the
 * code on to people the host isn't sitting near, and everyone can check
 * the photo of the bill against what they had.
 */
import { useState } from 'react';
import { useBillImageUrl } from '@gdp/core/api/hooks/useBillImageUrl';
import { Button, Dialog, PhotoIcon, QrIcon, Spinner } from './ui';

export function BillTools({ sessionId, billId, showQr }: { sessionId: string; billId: string; showQr: boolean }) {
  const [photo, setPhoto] = useState(false);
  return (
    <>
      <div className="tools">
        {showQr ? <Button tone="secondary" small href={`/session/${sessionId}/share`}><QrIcon />QR code</Button> : null}
        <Button tone="secondary" small onClick={() => setPhoto(true)}><PhotoIcon />Bill photo</Button>
      </div>
      {photo ? <BillPhoto billId={billId} onClose={() => setPhoto(false)} /> : null}
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
