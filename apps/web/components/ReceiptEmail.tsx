'use client';

/**
 * G4.3 (#220): on *All square*, a guest can have their receipt emailed.
 * Optional, not a sign-in, and not saved to an account: the address goes
 * with the bill.
 */
import { useState } from 'react';
import { ApiError } from '@gdp/core/api';
import { useEmailReceipt } from '@gdp/core/api/hooks/useTexts';
import { Button } from './ui';

export function ReceiptEmail({ sessionId }: { sessionId: string }) {
  const send = useEmailReceipt(sessionId);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const submit = async () => {
    const to = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      setError('That doesn’t look like an email address.');
      return;
    }
    setError(null);
    try {
      await send.mutateAsync(to);
      setSentTo(to);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'RATE_LIMITED' ? err.message : 'Didn’t send. Try again.');
    }
  };

  if (sentTo) return <p className="small" role="status">Receipt sent to {sentTo}.</p>;
  return (
    <form className="receipt-email" noValidate onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="field">
        <label htmlFor="receipt-email">Email me the receipt</label>
        <div className="receipt-email__row">
          <input
            id="receipt-email"
            className={error ? 'input input--invalid' : 'input'}
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => { setEmail(e.target.value); if (error) setError(null); }}
            aria-invalid={!!error}
            aria-describedby={error ? 'receipt-email-err' : undefined}
          />
          <Button type="submit" tone="secondary" small busy={send.isPending}>Send</Button>
        </div>
        {error ? <div id="receipt-email-err" className="field__err" role="alert">{error}</div> : null}
      </div>
    </form>
  );
}
