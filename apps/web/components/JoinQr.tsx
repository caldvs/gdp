'use client';

import { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { buildJoinUrl } from '@gdp/core/lib/qrPayload';
import type { PayoutAccount } from '@gdp/core/lib/payoutAccount';
import { publicBaseUrl } from '@/lib/config';

/**
 * Join URL for a session: `${origin}/join/CODE#p=<bank details>`.
 * Built after mount (needs window.location and a fresh `iat`, since the
 * fragment expires 10 minutes after it's encoded). Re-encoded every few
 * minutes so a QR left on screen stays scannable. Pass `ttlMs` for a
 * link that will be copied or shared (SHARED_LINK_TTL_MS).
 */
export function useJoinUrl(joinCode: string | undefined, payout: PayoutAccount | null, ttlMs?: number): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!joinCode) { setUrl(null); return; }
    const build = () => setUrl(buildJoinUrl(publicBaseUrl(), joinCode, payout, undefined, ttlMs));
    build();
    const t = setInterval(build, 4 * 60_000);
    return () => clearInterval(t);
  }, [joinCode, payout, ttlMs]);
  return url;
}

const TILES = 10;
// Fixed, scattered order for the tiles to clear in (same on server and client).
const TILE_DELAYS = Array.from({ length: TILES * TILES }, (_, i) => ((i * 37 + (i % 7) * 53) % 97) * 8);

/**
 * The join QR. `building` (#129): the real code fills in tile by tile over
 * about a second, after the fee or credit. Reduced motion shows it at once.
 */
export function JoinQr({ url, size = 240, building }: { url: string | null; size?: number; building?: boolean }) {
  return (
    <div className="qr" style={{ width: size, height: size }}>
      {url ? <QRCodeSVG value={url} size={size} level="M" bgColor="#ffffff" fgColor="#0B0C0E" title="Scan to join this bill" /> : null}
      {building && url ? (
        <div className="qr__cover" aria-hidden="true">
          {TILE_DELAYS.map((d, i) => <span key={i} style={{ animationDelay: `${d}ms` }} />)}
        </div>
      ) : null}
    </div>
  );
}

/** How long the QR takes to fill in. */
export const QR_BUILD_MS = 1000;

/** True once a building QR has filled in (at once with reduced motion). */
export function useQrBuilt(building: boolean, url: string | null): boolean {
  const [built, setBuilt] = useState(!building);
  useEffect(() => {
    if (built || !url) return;
    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const t = setTimeout(() => setBuilt(true), reduced ? 0 : QR_BUILD_MS);
    return () => clearTimeout(t);
  }, [built, url]);
  return built;
}
