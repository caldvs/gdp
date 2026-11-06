import { useState } from 'react';
import { JoinQr } from '@/components/JoinQr';
import { Box, Button, Dialog, MoreIcon, QrIcon, RowButton } from '@/components/ui';

/**
 * The bill title's buttons for stories. The real BillTools needs the API, so
 * this stand-in shows the same buttons: the QR icon opens a dummy QR code, and
 * "⋯" opens the same sheet with buttons that do nothing.
 */
export function StoryBillTools() {
  const [open, setOpen] = useState<null | 'qr' | 'more'>(null);
  const close = () => setOpen(null);
  return (
    <>
      <div className="tools">
        <button type="button" className="tool" onClick={() => setOpen('qr')} aria-label="QR code" title="QR code"><QrIcon /></button>
        <button type="button" className="tool" onClick={() => setOpen('more')} aria-label="More" aria-haspopup="dialog" title="More"><MoreIcon /></button>
      </div>
      {open === 'qr' ? (
        <Dialog id="story-qr-t" title="Share with the table" onClose={close} actions={<Button tone="secondary" onClick={close}>Close</Button>}>
          <div className="qr-box">
            <JoinQr url="https://example.com/join/demo-not-a-real-bill" size={208} />
            <p className="small muted">A dummy code: it opens nothing.</p>
          </div>
        </Dialog>
      ) : null}
      {open === 'more' ? (
        <Dialog id="story-more-t" title="This bill" onClose={close} actions={<Button tone="secondary" onClick={close}>Close</Button>}>
          <Box list>
            <RowButton title="Bill photo" chevron onClick={() => {}} />
            <RowButton title="Email me a report" onClick={() => {}} />
          </Box>
        </Dialog>
      ) : null}
    </>
  );
}
