'use client';

/**
 * #226 Proof of payment, on the guest's G4 *Waiting for …*: offered once
 * the lead hasn't marked the payment received 30 seconds after *I've paid*
 * (counted from the server's time, so a reload doesn't restart it). The
 * guest crops out their balance and account numbers; only the cropped
 * image, re-encoded as JPEG in the browser (no EXIF or GPS), is uploaded.
 * Only the lead sees it. A screenshot isn't payment: the lead still marks
 * it received.
 */
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { processImage } from '@gdp/core/lib/image';
import { useProofs, useRemoveProof, useSendProof } from '@gdp/core/api/hooks/useProofs';
import { Button, Notice, Section } from '@/components/ui';

const OFFER_AFTER_MS = 30_000;
const MAX_EDGE = 1600;
const MAX_BYTES = 2 * 1024 * 1024;
const MIN = 0.1;

type Rect = { x: number; y: number; w: number; h: number };
type Corner = 'tl' | 'tr' | 'bl' | 'br';
const CORNERS: { id: Corner; label: string }[] = [
  { id: 'tl', label: 'Top-left corner' },
  { id: 'tr', label: 'Top-right corner' },
  { id: 'bl', label: 'Bottom-left corner' },
  { id: 'br', label: 'Bottom-right corner' },
];

/** True once `since` (server time) is 30s old; re-renders when it gets there. */
export function useProofOffered(since: string | undefined): boolean {
  const due = since ? new Date(since).getTime() + OFFER_AFTER_MS : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (due === undefined || now >= due) return;
    const t = setTimeout(() => setNow(Date.now()), due - now + 50);
    return () => clearTimeout(t);
  }, [due, now]);
  return due !== undefined && now >= due;
}

export function ProofOfPayment({ sessionId, host, onCropping }: { sessionId: string; host: string; onCropping?: (on: boolean) => void }) {
  const proofs = useProofs(sessionId);
  const sendProof = useSendProof(sessionId);
  const remove = useRemoveProof(sessionId);
  const input = useRef<HTMLInputElement>(null);
  const [img, setImg] = useState<{ uri: string } | null>(null);
  const [rect, setRect] = useState<Rect>({ x: 0, y: 0, w: 1, h: 1 / 3 });
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => { onCropping?.(!!img); }, [img, onCropping]);
  useEffect(() => () => { if (img) URL.revokeObjectURL(img.uri); }, [img]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setErr(null);
    setReading(true);
    try {
      // HEIC converted, re-encoded as JPEG, as for bills.
      const p = await processImage(file, file.name);
      setRect({ x: 0, y: 0, w: 1, h: 1 / 3 });
      setImg({ uri: p.uri });
    } catch {
      setErr('That image couldn’t be opened. Try another.');
    } finally {
      setReading(false);
    }
  };

  const send = async () => {
    if (!img) return;
    setErr(null);
    try {
      const jpeg = await crop(img.uri, rect);
      sendProof.mutate(jpeg, { onSuccess: () => setImg(null) });
    } catch {
      setErr('That image couldn’t be cropped. Try another.');
    }
  };

  const sent = proofs.data ?? [];
  const chooser = (
    <input ref={input} type="file" accept="image/*,.heic,.heif" hidden aria-label="Choose a screenshot" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
  );

  if (img) {
    return (
      <Section title="Proof of payment">
        {chooser}
        <Notice tone="warn">Crop out your balance and account numbers. Only the payment needs to show.</Notice>
        <CropFrame src={img.uri} rect={rect} onChange={setRect} />
        {err || sendProof.isError ? <p className="field__err" role="alert">{err ?? sendProof.error?.message}</p> : null}
        <div className="proof__acts">
          <Button busy={sendProof.isPending} onClick={() => void send()}>Send to {host}</Button>
          <Button tone="secondary" disabled={sendProof.isPending} onClick={() => input.current?.click()}>Choose another</Button>
        </div>
      </Section>
    );
  }

  if (sent.length > 0) {
    return (
      <Section title="Proof of payment">
        {sent.map((p) => (
          <div key={p.proofId} className="proof__sent">
            {/* eslint-disable-next-line @next/next/no-img-element -- a short-lived signed S3 URL */}
            <img src={p.url} alt="Your screenshot" className="proof__thumb" />
            <span className="proof__sent-text">
              <b>Sent to {host}.</b>
              <span className="small muted">Only {host} sees it. Deleted after a month.</span>
              <button type="button" className="link-btn small" disabled={remove.isPending} onClick={() => remove.mutate(p.proofId)}>Remove</button>
            </span>
          </div>
        ))}
        {remove.isError ? <p className="field__err" role="alert">{remove.error.message}</p> : null}
      </Section>
    );
  }

  return (
    <Section title="Proof of payment">
      {chooser}
      <p className="muted">Bank transfers can take a while. Send {host} a screenshot of your payment.</p>
      {err ? <p className="field__err" role="alert">{err}</p> : null}
      <Button tone="secondary" busy={reading} onClick={() => input.current?.click()}>Attach a screenshot</Button>
    </Section>
  );
}

/** A frame over the image with four corners to drag (or move with the arrow keys). */
function CropFrame({ src, rect, onChange }: { src: string; rect: Rect; onChange: (r: Rect) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<Corner | null>(null);

  const moveCorner = (c: Corner, px: number, py: number) => {
    const clamp = (v: number) => Math.min(1, Math.max(0, v));
    px = clamp(px); py = clamp(py);
    let { x, y, w, h } = rect;
    const right = x + w, bottom = y + h;
    if (c === 'tl' || c === 'bl') { const nx = Math.min(px, right - MIN); w = right - nx; x = nx; }
    else { w = Math.max(MIN, px - x); }
    if (c === 'tl' || c === 'tr') { const ny = Math.min(py, bottom - MIN); h = bottom - ny; y = ny; }
    else { h = Math.max(MIN, py - y); }
    onChange({ x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) });
  };
  const at = (c: Corner) => ({ px: c === 'tl' || c === 'bl' ? rect.x : rect.x + rect.w, py: c === 'tl' || c === 'tr' ? rect.y : rect.y + rect.h });

  const onMove = (e: ReactPointerEvent) => {
    const c = drag.current;
    const r = box.current?.getBoundingClientRect();
    if (!c || !r) return;
    moveCorner(c, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };
  const onKey = (c: Corner) => (e: KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!d) return;
    e.preventDefault();
    const { px, py } = at(c);
    moveCorner(c, px + d[0]!, py + d[1]!);
  };
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

  return (
    <div ref={box} className="crop" onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL */}
      <img src={src} alt="Your screenshot" draggable={false} />
      <div className="crop__frame" style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }} data-testid="crop-frame">
        {CORNERS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`crop__corner crop__corner--${c.id}`}
            aria-label={`${c.label}. Arrow keys move it.`}
            onPointerDown={(e) => { drag.current = c.id; (e.currentTarget.parentElement?.parentElement as HTMLElement | null)?.setPointerCapture?.(e.pointerId); }}
            onKeyDown={onKey(c.id)}
          />
        ))}
      </div>
    </div>
  );
}

/** Draws just the frame onto a canvas and re-encodes it: nothing else leaves the phone. */
async function crop(uri: string, r: Rect): Promise<Blob> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = uri;
  });
  const sx = Math.round(r.x * image.naturalWidth), sy = Math.round(r.y * image.naturalHeight);
  const sw = Math.max(1, Math.round(r.w * image.naturalWidth)), sh = Math.max(1, Math.round(r.h * image.naturalHeight));
  const scale = Math.min(1, MAX_EDGE / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  for (const q of [0.85, 0.7, 0.5]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', q));
    if (blob && blob.size <= MAX_BYTES) return blob;
  }
  throw new Error('too big');
}
