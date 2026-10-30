'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Backdrop + centred card. Closes on Escape and backdrop click. */
export function Overlay({ open, onClose, children, label, className = 'dialog' }: {
  open: boolean; onClose: () => void; children: ReactNode; label: string; className?: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    cardRef.current?.querySelector<HTMLElement>('button, [href], input')?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="overlay" onClick={onClose}>
      <div ref={cardRef} className={className} role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function ConfirmDialog({ visible, title, body, confirmLabel = 'Confirm', cancelLabel = 'Cancel', destructive, onConfirm, onCancel }: {
  visible: boolean; title: string; body?: string; confirmLabel?: string; cancelLabel?: string; destructive?: boolean;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <Overlay open={visible} onClose={onCancel} label={title}>
      <h2 className="dialog__title">{title}</h2>
      {body ? <p className="dialog__body">{body}</p> : null}
      <div className="dialog__actions">
        <button type="button" className="btn btn--ghost" onClick={onCancel}>{cancelLabel}</button>
        <button type="button" className={destructive ? 'btn btn--danger' : 'btn'} style={{ flex: 1 }} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Overlay>
  );
}
