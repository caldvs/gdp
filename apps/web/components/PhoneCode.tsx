'use client';

/**
 * The pieces phone sign-in (#213) and a guest joining (#214) share: the
 * +44 number field, the four code boxes, and the resend countdown.
 */
import { useEffect, useState, type RefObject } from 'react';
import { Button } from './ui';

export const PHONE_CODE_LENGTH = 4;
export const RESEND_SECONDS = 60;

/** `+447700900123` → `+44 7700 900123`. */
export const shownPhone = (e164: string) =>
  e164.startsWith('+44') && e164.length === 13 ? `+44 ${e164.slice(3, 7)} ${e164.slice(7)}` : e164;

/** Loose check before asking the server: a UK mobile, 07… or 7… */
export const looksLikeUkMobile = (typed: string) =>
  /^(?:\+?44|0)?7\d{9}$/.test(typed.replace(/[\s().-]/g, '').replace(/^0044/, '44'));

export const NOT_A_MOBILE = 'Enter a UK mobile number, like 07700 900123.';

/** Seconds left before a new code can go, and a way to start the clock. */
export function useCountdown(): [number, (seconds: number) => void] {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, [left]);
  return [left, setLeft];
}

export function PhoneField({ id = 'phone', value, onChange, error, disabled, hint }: {
  id?: string;
  value: string;
  onChange: (typed: string) => void;
  error?: string | null;
  disabled?: boolean;
  /** Shown under the field when there's no error. */
  hint?: string;
}) {
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>Your mobile number</label>
      <div className={error ? 'input affix affix--gap input--invalid' : 'input affix affix--gap'}>
        <span>+44</span>
        <input
          id={id}
          type="tel"
          inputMode="tel"
          autoComplete="tel-national"
          enterKeyHint="go"
          placeholder="7700 900123"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={describedBy}
        />
      </div>
      {error ? <div id={`${id}-err`} className="field__err" role="alert">{error}</div> : hint ? <div id={`${id}-hint`} className="field__hint">{hint}</div> : null}
    </div>
  );
}

/** The four boxes. Goes as soon as the code is whole: typed, pasted or filled in from the text. */
export function CodeBoxes({ value, onChange, onComplete, disabled, error, inputRef }: {
  value: string;
  onChange: (digits: string) => void;
  onComplete: (digits: string) => void;
  disabled?: boolean;
  error?: string | null;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="field">
      <label htmlFor="code" className="vh">4-digit code</label>
      <div className="code4">
        <input
          ref={inputRef}
          id="code"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="one-time-code"
          maxLength={PHONE_CODE_LENGTH}
          value={value}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={error ? 'code-err' : undefined}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '').slice(0, PHONE_CODE_LENGTH);
            onChange(digits);
            if (digits.length === PHONE_CODE_LENGTH) onComplete(digits);
          }}
        />
        {Array.from({ length: PHONE_CODE_LENGTH }, (_, i) => (
          <span key={i} aria-hidden="true" className={i === Math.min(value.length, PHONE_CODE_LENGTH - 1) && !disabled ? 'code4__box code4__box--on' : 'code4__box'}>
            {value[i] ?? ''}
          </span>
        ))}
      </div>
      {error ? <div id="code-err" className="field__err" role="alert">{error}</div> : null}
    </div>
  );
}

/** *Send a new code* once the clock runs out (or the code has gone), else the time left. */
export function ResendCode({ countdown, expired, busy, onResend }: { countdown: number; expired: boolean; busy?: boolean; onResend: () => void }) {
  if (expired || countdown <= 0) {
    return <Button tone={expired ? 'primary' : 'text'} busy={busy} onClick={onResend}>Send a new code</Button>;
  }
  return <p className="field__hint">New code in {Math.floor(countdown / 60)}:{String(countdown % 60).padStart(2, '0')}</p>;
}
