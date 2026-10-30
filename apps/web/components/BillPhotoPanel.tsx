'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Maximize2, Minus, Plus, RotateCcw } from 'lucide-react';
import { useBillImageUrl } from '@gdp/core/api/hooks/useBillImageUrl';
import { Spinner } from './ui';

const COLLAPSED_KEY = 'gdp.billPhoto.collapsed';
const MIN = 1;
const MAX = 4;

/**
 * The bill photo, kept on screen next to the items while the lead checks
 * them. Phone: pinned under the top bar (collapsible). Wide screens:
 * a sticky left-hand column. Zoom with the buttons or double-click/tap;
 * pan by scrolling, swiping, or dragging with the mouse.
 */
export function BillPhotoPanel({ billId, onExpand }: { billId: string; onExpand: () => void }) {
  const q = useBillImageUrl(billId, true);
  const [zoom, setZoom] = useState(1);
  const [collapsed, setCollapsed] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  const [wide, setWide] = useState(false);

  useEffect(() => {
    try { setCollapsed(localStorage.getItem(COLLAPSED_KEY) === '1'); } catch { /* storage unavailable */ }
    const mq = window.matchMedia('(min-width: 960px)');
    const sync = () => setWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  // Side by side there's room for it, so it never collapses.
  const isCollapsed = collapsed && !wide;
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1'); } catch { /* ignore */ }
      return !c;
    });
  };

  // Zoom around a point in the viewport (defaults to the centre), keeping
  // that point of the bill under the same spot on screen.
  const zoomTo = (next: number, at?: { x: number; y: number }) => {
    const el = viewport.current;
    const z = Math.min(MAX, Math.max(MIN, next));
    if (!el) return setZoom(z);
    const px = at?.x ?? el.clientWidth / 2;
    const py = at?.y ?? el.clientHeight / 2;
    const ratio = z / zoom;
    const left = (el.scrollLeft + px) * ratio - px;
    const top = (el.scrollTop + py) * ratio - py;
    setZoom(z);
    requestAnimationFrame(() => el.scrollTo({ left, top }));
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    const r = viewport.current!.getBoundingClientRect();
    zoomTo(zoom > 1 ? 1 : 2.5, { x: e.clientX - r.left, y: e.clientY - r.top });
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || zoom === 1) return; // touch pans natively
    const el = viewport.current!;
    drag.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    el.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    viewport.current!.scrollTo({ left: d.left - (e.clientX - d.x), top: d.top - (e.clientY - d.y) });
  };
  const endDrag = () => { drag.current = null; };

  return (
    <section className={`photo-panel${isCollapsed ? ' photo-panel--collapsed' : ''}`} aria-label="Bill photo">
      <div className="photo-panel__bar">
        <button type="button" className="photo-panel__toggle" onClick={toggleCollapsed} aria-expanded={!isCollapsed} disabled={wide}>
          <span className="gdp-mini">bill photo</span>
          {wide ? null : isCollapsed ? <ChevronDown size={14} aria-hidden /> : <ChevronUp size={14} aria-hidden />}
        </button>
        {!isCollapsed && q.data ? (
          <div className="photo-panel__tools">
            <button type="button" aria-label="Zoom out" onClick={() => zoomTo(zoom - 0.5)} disabled={zoom <= MIN}><Minus size={15} /></button>
            <span className="photo-panel__zoom" aria-live="polite">{Math.round(zoom * 100)}%</span>
            <button type="button" aria-label="Zoom in" onClick={() => zoomTo(zoom + 0.5)} disabled={zoom >= MAX}><Plus size={15} /></button>
            <button type="button" aria-label="Fit to panel" onClick={() => zoomTo(1)} disabled={zoom === 1}><RotateCcw size={14} /></button>
            <button type="button" aria-label="Open full screen" onClick={onExpand}><Maximize2 size={14} /></button>
          </div>
        ) : null}
      </div>
      {!isCollapsed ? (
        <div
          ref={viewport}
          className={`photo-panel__viewport${zoom > 1 ? ' is-zoomed' : ''}`}
          onDoubleClick={q.data ? onDoubleClick : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {q.isPending ? (
            <div className="photo-panel__msg"><Spinner /></div>
          ) : q.isError ? (
            <div className="photo-panel__msg">
              {q.error.status === 404 ? "The original photo isn't stored for this bill." : "Couldn't load the photo."}
            </div>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={q.data.url}
              alt="Photo of the original bill"
              draggable={false}
              style={{ width: `${zoom * 100}%` }}
            />
          )}
        </div>
      ) : null}
    </section>
  );
}
