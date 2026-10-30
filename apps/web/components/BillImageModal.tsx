'use client';

import { useBillImageUrl } from '@gdp/core/api/hooks/useBillImageUrl';
import { Overlay } from './Dialog';
import { Spinner } from './ui';

export function BillImageModal({ billId, visible, onClose }: { billId: string | undefined; visible: boolean; onClose: () => void }) {
  const q = useBillImageUrl(billId, visible);
  return (
    <Overlay open={visible} onClose={onClose} label="Original bill" className="dialog image-dialog">
      <div className="image-dialog__head">
        <h2 className="dialog__title">Original bill</h2>
        <button type="button" className="btn btn--quiet" onClick={onClose}>Close</button>
      </div>
      <div className="image-dialog__frame">
        {q.isPending ? (
          <Spinner />
        ) : q.isError ? (
          <div className="center" style={{ minHeight: 0 }}>
            <b>{q.error.status === 404 ? 'Image not available' : "Couldn't load image"}</b>
            <p className="gdp-body t-center">
              {q.error.status === 404
                ? "The original photo isn't stored for this bill. (Older bills, before we kept the upload reference.)"
                : q.error.message}
            </p>
          </div>
        ) : q.data ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={q.data.url} alt="Photo of the original bill" />
        ) : null}
      </div>
    </Overlay>
  );
}
