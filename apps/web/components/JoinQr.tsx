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
 * minutes so a QR left on screen stays scannable.
 */
export function useJoinUrl(joinCode: string | undefined, payout: PayoutAccount | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!joinCode) { setUrl(null); return; }
    const build = () => setUrl(buildJoinUrl(publicBaseUrl(), joinCode, payout));
    build();
    const t = setInterval(build, 4 * 60_000);
    return () => clearInterval(t);
  }, [joinCode, payout]);
  return url;
}

export function JoinQr({ url, size = 240 }: { url: string | null; size?: number }) {
  return (
    <div className="qr-card" style={{ width: size + 34, height: size + 34 }}>
      {url ? <QRCodeSVG value={url} size={size} level="M" bgColor="#ffffff" fgColor="#0f1417" title="Scan to join this bill" /> : null}
    </div>
  );
}
