'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ApiError } from '@gdp/core/api';
import { useStartPhoneSignIn, useUpdateMe, useVerifyPhoneCode } from '@gdp/core/api/hooks/usePhoneSignIn';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { BackButton, Button, Title } from './ui';

/**
 * #213 M4 / M4.1: your mobile number, then the 4-digit code by text (#231)
 * or WhatsApp,
 * in the same tab. A new account then gives its name and the email its
 * bill emails go to. Texts come with #231, so there's no *Send it by text
 * instead* yet.
 */

const CODE_LENGTH = 4;
const STACK = { display: 'flex', flexDirection: 'column', gap: 12 } as const;
const RESEND_SECONDS = 60;
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

/** `+447700900123` → `+44 7700 900123`. */
const shown = (e164: string) => (e164.startsWith('+44') && e164.length === 13 ? `+44 ${e164.slice(3, 7)} ${e164.slice(7)}` : e164);

/** Loose check before asking the server: a UK mobile, 07… or 7… */
const looksLikeUkMobile = (typed: string) => /^(?:\+?44|0)?7\d{9}$/.test(typed.replace(/[\s().-]/g, '').replace(/^0044/, '44'));

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
  const [countdown, setCountdown] = useState(0);
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

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setInterval(() => setCountdown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [countdown]);

  const send = async (number: string) => {
    setError(null);
    try {
      const out = await start.mutateAsync({ phone: number, channel });
      writePending({ phone: out.phone, requestId: out.requestId });
      setPhone(out.phone);
      setRequestId(out.requestId);
      setCode('');
      setStage('CODE');
      setCountdown(RESEND_SECONDS);
    } catch (err) {
      setError(
        err instanceof ApiError && (err.code === 'RATE_LIMITED' || err.code === 'INVALID_INPUT' || err.code === 'CHANNEL_UNAVAILABLE')
          ? err.message
          : 'Couldn’t send the code. Check your connection.',
      );
    }
  };

  const submitCode = async (entered: string) => {
    if (!requestId || verify.isPending || entered.length !== CODE_LENGTH) return;
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
            if (!looksLikeUkMobile(typed)) return setError('Enter a UK mobile number, like 07700 900123.');
            void send(typed);
          }}
        >
          <div className="field">
            <label htmlFor="phone">Your mobile number</label>
            <div className={error ? 'input affix affix--gap input--invalid' : 'input affix affix--gap'}>
              <span>+44</span>
              <input
                id="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                enterKeyHint="go"
                placeholder="7700 900123"
                value={typed}
                onChange={(e) => { setTyped(e.target.value); if (error) setError(null); }}
                disabled={start.isPending}
                aria-invalid={!!error}
                aria-describedby={error ? 'phone-err' : undefined}
              />
            </div>
            {error ? <div id="phone-err" className="field__err" role="alert">{error}</div> : null}
          </div>
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
      <Title title="Enter the code" sub={`Sent to ${shown(phone)} ${how}. Works for 10 minutes.`} />
      <form noValidate style={STACK} onSubmit={(e) => { e.preventDefault(); void submitCode(code); }}>
        <div className="field">
          <label htmlFor="code" className="vh">4-digit code</label>
          <div className="code4">
            <input
              ref={codeInput}
              id="code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={CODE_LENGTH}
              value={code}
              disabled={expired || verify.isPending}
              aria-invalid={!!error}
              aria-describedby={error ? 'code-err' : undefined}
              onChange={(e) => {
                const digits = e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH);
                setCode(digits);
                if (error) setError(null);
                if (digits.length === CODE_LENGTH) void submitCode(digits);
              }}
            />
            {Array.from({ length: CODE_LENGTH }, (_, i) => (
              <span key={i} aria-hidden="true" className={i === Math.min(code.length, CODE_LENGTH - 1) && !expired ? 'code4__box code4__box--on' : 'code4__box'}>
                {code[i] ?? ''}
              </span>
            ))}
          </div>
          {error ? <div id="code-err" className="field__err" role="alert">{error}</div> : null}
        </div>
      </form>
      {expired || countdown <= 0 ? (
        <Button tone={expired ? 'primary' : 'text'} busy={start.isPending} onClick={() => void send(phone)}>Send a new code</Button>
      ) : (
        <p className="field__hint">New code in {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}</p>
      )}
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
