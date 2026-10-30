'use client';

import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePayoutAccount, useSavePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { DEMO_MODE, DEMO_PAYOUT } from '@gdp/core/lib/demoMode';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { BodyText, Button, CenterSpinner, DisplayText, Mini, Notice, Spinner } from '@/components/ui';

type FieldKey = 'name' | 'sortCode' | 'accountNumber' | 'monzo' | 'revolut';

const digits = (s: string, max: number) => s.replace(/\D/g, '').slice(0, max);

function validateSortCode(raw: string): string | null {
  const d = digits(raw, 6);
  if (d.length === 0) return 'Sort code is required.';
  if (d.length !== 6) return `${6 - d.length} more digit${6 - d.length === 1 ? '' : 's'}.`;
  return null;
}
function validateAccountNumber(raw: string): string | null {
  const d = digits(raw, 8);
  if (d.length === 0) return 'Account number is required.';
  if (d.length !== 8) return `${8 - d.length} more digit${8 - d.length === 1 ? '' : 's'}.`;
  return null;
}
function validateName(raw: string): string | null {
  return raw.trim() ? null : 'Whose account is this?';
}
function formatSort(raw: string): string {
  const d = digits(raw, 6);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}`;
}

export default function PayoutAccountPage() {
  return (
    <Suspense fallback={<CenterSpinner />}>
      <PayoutAccountForm />
    </Suspense>
  );
}

function PayoutAccountForm() {
  const router = useRouter();
  const returnTo = useSearchParams().get('returnTo');
  const stored = usePayoutAccount();
  const { save, isSaving } = useSavePayoutAccount();

  const [sortCode, setSortCode] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [accountHolderName, setAccountHolderName] = useState('');
  const [monzoHandle, setMonzoHandle] = useState('');
  const [revolutTag, setRevolutTag] = useState('');
  const [editing, setEditing] = useState<FieldKey | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [showOptional, setShowOptional] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    if (DEMO_MODE) {
      setSortCode(DEMO_PAYOUT.sortCode);
      setAccountNumber(DEMO_PAYOUT.accountNumber);
      setAccountHolderName(DEMO_PAYOUT.accountHolderName);
      setHydrated(true);
      return;
    }
    if (stored.isPending) return;
    if (stored.data) {
      const pa = stored.data;
      setSortCode(pa.sortCode);
      setAccountNumber(pa.accountNumber);
      setAccountHolderName(pa.accountHolderName);
      setMonzoHandle(pa.monzoHandle ?? '');
      setRevolutTag(pa.revolutTag ?? '');
      if (pa.monzoHandle || pa.revolutTag) setShowOptional(true);
    } else {
      setEditing('name');
    }
    setHydrated(true);
  }, [hydrated, stored.isPending, stored.data]);

  const nameError = tried ? validateName(accountHolderName) : null;
  const sortError = tried ? validateSortCode(sortCode) : null;
  const accountError = tried ? validateAccountNumber(accountNumber) : null;
  const ready = !nameError && !sortError && !accountError;

  const onSave = async () => {
    setSubmitError(null);
    setTried(true);
    if (validateName(accountHolderName) || validateSortCode(sortCode) || validateAccountNumber(accountNumber)) {
      // Open the first broken field so the fix is one tap away.
      setEditing(validateName(accountHolderName) ? 'name' : validateSortCode(sortCode) ? 'sortCode' : 'accountNumber');
      return;
    }
    try {
      await save({
        sortCode: digits(sortCode, 6),
        accountNumber: digits(accountNumber, 8),
        accountHolderName: accountHolderName.trim(),
        ...(monzoHandle.trim() ? { monzoHandle: monzoHandle.trim() } : {}),
        ...(revolutTag.trim() ? { revolutTag: revolutTag.trim() } : {}),
      });
      if (returnTo) router.replace(safeInternalPath(returnTo));
      else if (window.history.length > 1) router.back();
      else router.replace('/');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Could not save details.');
    }
  };

  if (stored.isPending && !hydrated) return <CenterSpinner />;

  const toggle = (k: FieldKey) => { if (!DEMO_MODE) setEditing(editing === k ? null : k); };

  return (
    <>
      <form className="screen screen--sticky stack" onSubmit={(e) => { e.preventDefault(); void onSave(); }}>
        <Mini>your payout</Mini>
        <DisplayText size="md" as="h2" className="mt-xs">Where should the money land?</DisplayText>
        <BodyText className="mt-sm">Diners pay you direct. Your details reach them inside the QR code — they never touch our servers.</BodyText>
        <Mini className="mt-sm">kept in this browser tab · cleared when you close it</Mini>

        {DEMO_MODE ? (
          <Notice
            className="mt-base"
            title="Pre-filled for you"
            detail="These are the demo's stand-in bank details — what the QR will encode for your guests. The fields are read-only here so you can focus on the rest of the flow."
          />
        ) : null}

        <div className="pa-fields mt-lg">
          <CollapsedRow label="account name" value={accountHolderName} placeholder="tap to add" error={nameError}
            open={!DEMO_MODE && editing === 'name'} onToggle={() => toggle('name')} locked={DEMO_MODE}>
            <EditField value={accountHolderName} onChange={setAccountHolderName} placeholder="e.g. Alice Cooper"
              autoComplete="name" autoCapitalize="words" onDone={() => setEditing(null)} />
          </CollapsedRow>
          <CollapsedRow label="sort code" value={formatSort(sortCode)} placeholder="6 digits" error={sortError}
            open={!DEMO_MODE && editing === 'sortCode'} onToggle={() => toggle('sortCode')} locked={DEMO_MODE}>
            <EditField value={formatSort(sortCode)} onChange={(v) => setSortCode(formatSort(v))} placeholder="04-06-68"
              inputMode="numeric" maxLength={8} onDone={() => setEditing(null)} />
          </CollapsedRow>
          <CollapsedRow label="account number" value={accountNumber} placeholder="8 digits" error={accountError}
            open={!DEMO_MODE && editing === 'accountNumber'} onToggle={() => toggle('accountNumber')} locked={DEMO_MODE}>
            <EditField value={accountNumber} onChange={(v) => setAccountNumber(digits(v, 8))} placeholder="00079660"
              inputMode="numeric" maxLength={8} onDone={() => setEditing(null)} />
          </CollapsedRow>
        </div>

        {DEMO_MODE ? null : !showOptional ? (
          <button type="button" className="optional-toggle mt-base" onClick={() => setShowOptional(true)}>
            <span className="optional-toggle__t">+ Add a Monzo or Revolut handle</span>
            <Mini>optional · pay you in one tap</Mini>
          </button>
        ) : (
          <div className="pa-fields mt-base">
            <Mini className="mt-xs">faster pay · optional</Mini>
            <CollapsedRow label="monzo handle" value={monzoHandle ? `monzo.me/${monzoHandle}` : ''} placeholder="tap to add"
              open={editing === 'monzo'} onToggle={() => toggle('monzo')}>
              <EditField value={monzoHandle} onChange={setMonzoHandle} placeholder="callum.davies" prefix="monzo.me/"
                autoCapitalize="none" onDone={() => setEditing(null)}
                hint={<FindHint steps={[
                  'Open Monzo and tap your profile picture (top-left).',
                  "Tap 'Get paid' or 'Share your account'.",
                  "Copy the part after monzo.me/ — that's your handle.",
                ]} />} />
            </CollapsedRow>
            <CollapsedRow label="revolut tag" value={revolutTag ? `revolut.me/${revolutTag}` : ''} placeholder="tap to add"
              open={editing === 'revolut'} onToggle={() => toggle('revolut')}>
              <EditField value={revolutTag} onChange={setRevolutTag} placeholder="callumd" prefix="revolut.me/"
                autoCapitalize="none" onDone={() => setEditing(null)}
                hint={<FindHint steps={[
                  'Open Revolut and tap your profile picture (top-left).',
                  "Your @username is shown under your name — that's your Revtag.",
                  'Drop it in here without the @.',
                ]} />} />
            </CollapsedRow>
          </div>
        )}

        {submitError ? <Notice className="mt-base" title="Couldn't save." detail={submitError} /> : null}
        {/* hidden submit so Enter in any field saves */}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
      <div className="sticky-bar">
        <div className="sticky-bar__inner">
          <Button size="lg" disabled={isSaving || (!ready && tried)} onClick={() => void onSave()}>
            {isSaving ? <Spinner /> : 'Save details →'}
          </Button>
        </div>
      </div>
    </>
  );
}

function CollapsedRow({ label, value, placeholder, error, open, onToggle, children, locked }: {
  label: string; value: string; placeholder: string; error?: string | null; open: boolean; onToggle: () => void; children: ReactNode; locked?: boolean;
}) {
  return (
    <div className={open ? 'pa-row pa-row--open' : 'pa-row'}>
      <button type="button" className="pa-row__head" onClick={onToggle} disabled={locked} aria-expanded={open}>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="gdp-mini" style={{ display: 'block' }}>{label}</span>
          {!open ? <span className={value ? 'pa-row__value' : 'pa-row__value pa-row__value--placeholder'} style={{ display: 'block' }}>{value || placeholder}</span> : null}
          {!open && error ? <span className="pa-row__error" style={{ display: 'block' }}>{error}</span> : null}
        </span>
        {locked ? null : <span className={open ? 'pa-row__chev pa-row__chev--open' : 'pa-row__chev'} aria-hidden>{open ? '−' : '+'}</span>}
      </button>
      {open ? <div className="pa-edit">{children}</div> : null}
    </div>
  );
}

function EditField({ value, onChange, onDone, placeholder, inputMode, maxLength, autoCapitalize, autoComplete, prefix, hint }: {
  value: string; onChange: (v: string) => void; onDone: () => void; placeholder?: string;
  inputMode?: 'numeric' | 'text'; maxLength?: number; autoCapitalize?: string; autoComplete?: string; prefix?: string; hint?: ReactNode;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = setTimeout(() => ref.current?.focus(), 50); return () => clearTimeout(t); }, []);
  const onPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) onChange(text.trim());
    } catch {
      ref.current?.focus();
    }
  };
  return (
    <>
      <div className="pa-input">
        {prefix ? <span className="pa-input__prefix">{prefix}</span> : null}
        <input
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode={inputMode}
          maxLength={maxLength}
          autoCapitalize={autoCapitalize}
          autoComplete={autoComplete ?? 'off'}
          autoCorrect="off"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onDone(); } }}
        />
        <button type="button" className="pa-paste" onClick={onPaste} aria-label="Paste from clipboard">paste</button>
      </div>
      {hint ? <div className="hint-box">{hint}</div> : null}
      <button type="button" className="pa-done" onClick={onDone}>done</button>
    </>
  );
}

function FindHint({ steps }: { steps: string[] }) {
  return (
    <div>
      <Mini style={{ marginBottom: 4 }}>where to find it</Mini>
      {steps.map((s, i) => (
        <p key={i} className="hint-step"><b>{i + 1}. </b>{s}</p>
      ))}
    </div>
  );
}
