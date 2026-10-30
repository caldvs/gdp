'use client';

import { useEffect, useState } from 'react';
import { DEMO_MODE } from '@gdp/core/lib/demoMode';

const STORAGE_KEY = 'gdp.demoBannerDismissed';

export function DemoBanner() {
  const [dismissed, setDismissed] = useState(true);
  useEffect(() => {
    try {
      setDismissed(window.sessionStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      setDismissed(false);
    }
  }, []);
  if (!DEMO_MODE || dismissed) return null;
  return (
    <div className="demo-banner" role="status">
      <span className="demo-banner__tag">demo</span>
      <span>You&apos;re trying the app as a guest. Pretend the bill is yours — pre-filled details do the heavy lifting.</span>
      <button
        type="button"
        className="demo-banner__close"
        aria-label="Dismiss demo banner for this session"
        onClick={() => {
          try { window.sessionStorage.setItem(STORAGE_KEY, '1'); } catch {}
          setDismissed(true);
        }}
      >
        ×
      </button>
    </div>
  );
}
