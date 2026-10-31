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

export function JoinQr({ url, size = 240 }: { url: string | null; size?: number }) {
  return (
    <div style={{ width: size, height: size, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      {url ? <QRCodeSVG value={url} size={size} level="M" bgColor="#ffffff" fgColor="#0B0C0E" title="Scan to join this bill" /> : null}
    </div>
  );
}
