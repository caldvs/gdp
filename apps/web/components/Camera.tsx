'use client';

/**
 * Our own camera for scanning a bill: the back camera full screen, with a
 * bill-shaped guide over it. Falls back to the phone's camera app (the
 * `<input capture>`) when there's no camera API or permission is refused.
 */
import { useEffect, useRef, useState } from 'react';
import { CloseIcon } from './ui';

const GalleryIcon = () => (
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></svg>
);

/** True when the browser can show a live camera at all. */
export function hasLiveCamera(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

// `torch` is Chrome on Android only, and not in TypeScript's DOM types.
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };

// Not in TypeScript's DOM types yet (Chrome and Edge only).
type ImageCaptureLike = { takePhoto: () => Promise<Blob> };
declare const ImageCapture: { new (track: MediaStreamTrack): ImageCaptureLike } | undefined;

export function Camera({ onPhoto, onClose, onLibrary, onSystemCamera }: {
  onPhoto: (file: File) => void;
  onClose: () => void;
  /** The gallery button: the existing file picker. */
  onLibrary: () => void;
  /** No live camera: the phone's own camera app. Called from a tap. */
  onSystemCamera: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<'starting' | 'live' | 'denied'>('starting');
  const [torch, setTorch] = useState<boolean | null>(null); // null: no torch
  const [taking, setTaking] = useState(false);

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          audio: false,
          // Ask high: the browser gives the most the camera can do.
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 4096 } },
        });
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return; }
        stream.current = s;
        const track = s.getVideoTracks()[0];
        const caps = track?.getCapabilities?.() as TorchCapabilities | undefined;
        if (caps?.torch) setTorch(false);
        if (video.current) {
          video.current.srcObject = s;
          await video.current.play().catch(() => {});
        }
        setState('live');
      } catch {
        if (!stopped) setState('denied');
      }
    })();
    return () => {
      stopped = true;
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
    };
  }, []);

  const toggleTorch = async () => {
    const track = stream.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };

  const shoot = async () => {
    const track = stream.current?.getVideoTracks()[0];
    const v = video.current;
    if (!track || !v || taking) return;
    setTaking(true);
    try {
      let blob: Blob | null = null;
      if (typeof ImageCapture !== 'undefined') {
        // A full-resolution still, better than a video frame where it works.
        blob = await new ImageCapture(track).takePhoto().catch(() => null);
      }
      if (!blob) blob = await frame(v);
      onPhoto(new File([blob], 'bill.jpg', { type: blob.type || 'image/jpeg' }));
    } finally {
      setTaking(false);
    }
  };

  return (
    <div className="cam" role="dialog" aria-modal="true" aria-label="Scan a bill">
      <video ref={video} className="cam__video" playsInline muted autoPlay aria-hidden="true" />
      {state === 'denied' ? (
        <div className="cam__off">
          <p className="cam__off-title">No camera access</p>
          <button type="button" className="btn btn--primary" onClick={onSystemCamera}>Take a photo</button>
        </div>
      ) : (
        <Guide />
      )}

      <div className="cam__top">
        <button type="button" className="cam__btn" aria-label="Close camera" onClick={onClose}><CloseIcon /></button>
        <p className="cam__hint" role="status">{state === 'live' ? 'Whole bill in the frame' : ''}</p>
        {torch !== null ? (
          <button type="button" className="cam__btn" aria-label={torch ? 'Light off' : 'Light on'} aria-pressed={torch} onClick={() => void toggleTorch()}>
            <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill={torch ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2 5 13h6l-1 9 8-11h-6z" /></svg>
          </button>
        ) : <span className="cam__btn cam__btn--blank" aria-hidden="true" />}
      </div>

      <div className="cam__bottom">
        <button type="button" className="cam__btn cam__btn--sq" aria-label="Choose a photo" onClick={onLibrary}><GalleryIcon /></button>
        <button type="button" className="cam__shutter" aria-label="Take photo" disabled={state !== 'live' || taking} onClick={() => void shoot()}>
          <span aria-hidden="true" />
        </button>
        <span className="cam__btn cam__btn--sq cam__btn--blank" aria-hidden="true" />
      </div>
    </div>
  );
}

/** The bill-shaped zone: header, item lines, total. No words. */
function Guide() {
  const lines = [70, 54, 82, 62, 70, 48, 76, 58];
  return (
    <div className="cam__guide" aria-hidden="true">
      <div className="cam__guide-head">
        <span style={{ width: '60%', height: 14 }} />
        <span style={{ width: '75%' }} />
        <span style={{ width: '55%' }} />
      </div>
      <div className="cam__guide-lines">
        {lines.map((w, i) => (
          <div key={i}><span style={{ width: `${w}%` }} /><span style={{ width: '18%' }} /></div>
        ))}
      </div>
      <div className="cam__guide-foot">
        <div><span className="cam__guide-total" style={{ width: '34%' }} /><span className="cam__guide-total" style={{ width: '26%' }} /></div>
      </div>
    </div>
  );
}

/** The current video frame at the camera's full resolution, as a JPEG. */
function frame(v: HTMLVideoElement): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth;
  canvas.height = v.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('Could not take the photo.'));
  ctx.drawImage(v, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not take the photo.'))), 'image/jpeg', 0.95),
  );
}
