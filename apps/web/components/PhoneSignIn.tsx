'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useStartPhoneSignIn, useUpdateMe, useVerifyPhoneCode } from '@gdp/core/api/hooks/usePhoneSignIn';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { BackButton, Button, Title } from './ui';
import { CodeBoxes, NOT_A_MOBILE, PHONE_CODE_LENGTH, PhoneField, RESEND_SECONDS, ResendCode, looksLikeUkMobile, shownPhone, useCountdown } from './PhoneCode';

/**
 * #213 M4 / M4.1: your mobile number, then the 4-digit code by text (#231)
 * or WhatsApp, in the same tab. A new account then gives its name and the
 * email its bill emails go to.
 */

const STACK = { display: 'flex', flexDirection: 'column', gap: 12 } as const;
const PENDING_KEY = 'gdp.phoneSignIn.pending';
const PENDING_MS = 10 * 60 * 1000;

type Pending = { phone: string; requestId: string };

function readPending(): Pending | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { phone?: unknown; requestId?: unknown; sentAt?: unknown };
    if (typeof p.phone === 'string' && typeof p.requestId === 'string' && typeof p.sentAt === 'number' && Date.now() - p.sentAt < PENDING_MS) {
      return { phone: p.phone, requestId: p.requestId };
    }
    window.sessionStorage.removeItem(PENDING_KEY);
  } catch {}
  return null;
}

function writePending(p: Pending | null) {
  try {
    if (p) window.sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...p, sentAt: Date.now() }));
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {}
}

type Stage = 'PHONE' | 'CODE';

export function PhoneSignIn({ title = 'Sign in', channel = 'whatsapp', onUseEmail }: { title?: string; /** #231: texts where WhatsApp isn't set up. */ channel?: 'whatsapp' | 'sms'; onUseEmail?: () => void }) {
  const how = channel === 'sms' ? 'by text' : 'on WhatsApp';
  const router = useRouter();
  const dest = safeInternalPath(useSearchParams().get('from'));
  const [stage, setStage] = useState<Stage>('PHONE');
  const [typed, setTyped] = useState('');
  const [phone, setPhone] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [countdown, startCountdown] = useCountdown();
  const start = useStartPhoneSignIn();
  const verify = useVerifyPhoneCode();
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const p = readPending();
    if (!p) return;
    setPhone(p.phone);
    setRequestId(p.requestId);
    setStage('CODE');
  }, []);

  useEffect(() => {
    if (stage === 'CODE') codeInput.current?.focus();
  }, [stage]);

  const send = async (number: string) => {
    setError(null);
    try {
      const out = await start.mutateAsync({ phone: number, channel });
      writePending({ phone: out.phone, requestId: out.requestId });
      setPhone(out.phone);
      setRequestId(out.requestId);
      setCode('');
      setStage('CODE');
      startCountdown(RESEND_SECONDS);
    } catch (err) {
      setError(
        err instanceof ApiError && (err.code === 'RATE_LIMITED' || err.code === 'INVALID_INPUT' || err.code === 'CHANNEL_UNAVAILABLE')
          ? err.message
          : 'Couldn’t send the code. Check your connection.',
      );
    }
  };

  const submitCode = async (entered: string) => {
    if (!requestId || verify.isPending || entered.length !== PHONE_CODE_LENGTH) return;
    setError(null);
    try {
      const res = await verify.mutateAsync({ requestId, code: entered });
      if (res.status === 'signedIn') {
        writePending(null);
        // A new account is asked its name by the app shell (`needsName`).
        router.replace(dest);
        return;
      }
      setCode('');
      if (res.status === 'wrong') {
        setError(`Wrong code. ${res.attemptsLeft} ${res.attemptsLeft === 1 ? 'try' : 'tries'} left.`);
        codeInput.current?.focus();
        return;
      }
      writePending(null);
      setRequestId(null);
      setError('That code has expired. Send a new one.');
    } catch {
      setError('Couldn’t reach the server. Check your connection.');
    }
  };

  if (stage === 'PHONE') {
    return (
      <>
        <Title title={title} sub={channel === 'sms' ? 'We’ll text you a 4-digit code.' : 'We’ll send you a 4-digit code by WhatsApp.'} />
        <form
          noValidate
          style={STACK}
          onSubmit={(e) => {
            e.preventDefault();
            if (!looksLikeUkMobile(typed)) return setError(NOT_A_MOBILE);
            void send(typed);
          }}
        >
          <PhoneField value={typed} onChange={(v) => { setTyped(v); if (error) setError(null); }} error={error} disabled={start.isPending} />
          <Button type="submit" busy={start.isPending}>Send me a code</Button>
          {onUseEmail ? <Button tone="text" onClick={onUseEmail}>Use email instead</Button> : null}
        </form>
      </>
    );
  }

  const expired = !requestId;
  return (
    <>
      <BackButton onClick={() => { writePending(null); setRequestId(null); setCode(''); setError(null); setStage('PHONE'); }}>Change number</BackButton>
      <Title title="Enter the code" sub={`Sent to ${shownPhone(phone)} ${how}. Works for 10 minutes.`} />
      <form noValidate style={STACK} onSubmit={(e) => { e.preventDefault(); void submitCode(code); }}>
        <CodeBoxes
          inputRef={codeInput}
          value={code}
          onChange={(digits) => { setCode(digits); if (error) setError(null); }}
          onComplete={(digits) => void submitCode(digits)}
          disabled={expired || verify.isPending}
          error={error}
        />
      </form>
      <ResendCode countdown={countdown} expired={expired} busy={start.isPending} onResend={() => void send(phone)} />
    </>
  );
}

/** A new phone account: a name for the table, and where bill emails go. */
export function AboutYou({ onDone }: { onDone?: () => void }) {
  const update = useUpdateMe();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Title title="About you" sub="Friends see your name on the bill." />
      <form
        noValidate
        style={STACK}
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          const m = email.trim().toLowerCase();
          if (!n) return setError('Enter your name.');
          if (m && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) return setError('That doesn’t look like an email address.');
          setError(null);
          update.mutate({ displayName: n, ...(m ? { email: m } : {}) }, { onSuccess: onDone, onError: (err) => setError(err.message) });
        }}
      >
        <div className="field">
          <label htmlFor="name">Your name</label>
          <input id="name" className="input" autoComplete="given-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="input" type="email" autoComplete="email" autoCapitalize="none" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-describedby="email-hint" />
          <div id="email-hint" className="field__hint">For your bill emails. Not used to sign in.</div>
        </div>
        {error ? <p className="field__err" role="alert">{error}</p> : null}
        <Button type="submit" busy={update.isPending}>Continue</Button>
      </form>
    </>
  );
}
