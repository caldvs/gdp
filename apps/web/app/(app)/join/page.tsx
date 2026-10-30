'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@gdp/core/api';
import { ActionBar, BackLink, Button, Notice, Page, Title } from '@/components/ui';

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
      setError(err instanceof ApiError && err.code === 'NOT_FOUND' ? 'Can’t find that code' : 'Try again');
      setBusy(false);
    }
  };

  return (
    <>
      <Page sub>
        <BackLink href="/">Bills</BackLink>
        <Title title="Join a bill" sub="Enter the 6-letter code from the host’s screen, or scan their QR code with your camera." />
        <form id="join" onSubmit={go} className="field">
          <label htmlFor="code">Code</label>
          <input
            id="code"
            className={error ? 'input input--code input--invalid' : 'input input--code'}
            aria-label="6-letter code"
            value={code}
            onChange={(e) => { setCode(e.target.value.toUpperCase()); if (error) setError(null); }}
            placeholder="ABC123"
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            maxLength={6}
            autoFocus
          />
        </form>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </Page>
      <ActionBar>
        <Button grow type="submit" form="join" busy={busy} disabled={code.trim().length < 6}>Join</Button>
      </ActionBar>
    </>
  );
}
