'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@gdp/core/api';
import { Back, Backdrop, Btn, Fab, Notice, Screen, Sheet, TopBar } from '@/components/glass';

/** Type a 6-letter code when there's no QR to scan. */
export default function JoinByCodePage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length !== 6) { setError('Codes are 6 letters'); return; }
    setBusy(true);
    setError(null);
    try {
      await api<{ sessionId: string }>('/v1/sessions/by-code', { method: 'POST', body: { code: c } });
      router.push(`/join/${c}`);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'NOT_FOUND' ? "Can't find that code" : 'Try again');
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Backdrop tone="deep" />
      <TopBar left={<Fab href="/" label="Back" icon={<Back />} />} />
      <Sheet title="Join a bill">
        <form onSubmit={go} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            className="g-input g-input--mono"
            aria-label="6-letter code"
            value={code}
            onChange={(e) => { setCode(e.target.value.toUpperCase()); if (error) setError(null); }}
            placeholder="ABC123"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            maxLength={6}
            autoFocus
            style={{ textAlign: 'center', fontSize: 26, letterSpacing: '0.22em' }}
          />
          {error ? <Notice error>{error}</Notice> : null}
          <Btn type="submit" busy={busy} disabled={code.trim().length < 6}>Join</Btn>
        </form>
      </Sheet>
    </Screen>
  );
}
