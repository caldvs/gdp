'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePayoutAccount, useSavePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { isPayoutAccountRemembered } from '@gdp/core/lib/payoutAccount';
import { cleanHandle } from '@gdp/core/lib/quickPay';
import { DEMO_MODE, DEMO_PAYOUT } from '@gdp/core/lib/demoMode';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { Back, Backdrop, Btn, Centre, Fab, Notice, Screen, Sheet, Spin, TopBar } from '@/components/glass';

const digits = (s: string, max: number) => s.replace(/\D/g, '').slice(0, max);
function formatSort(raw: string): string {
  const d = digits(raw, 6);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}`;
}

export default function PayoutAccountPage() {
  return <Suspense fallback={<Centre><Spin /></Centre>}><PayoutForm /></Suspense>;
}

/**
 * "Where should the money land?" Three fields, optional Monzo/Revolut,
 * and "Save these for next time". Until accounts exist server-side,
 * saving means localStorage on this device (see payoutAccount.ts).
 */
function PayoutForm() {
  const router = useRouter();
  const returnTo = useSearchParams().get('returnTo');
  const stored = usePayoutAccount();
  const { save, isSaving } = useSavePayoutAccount();

  const [name, setName] = useState('');
  const [sort, setSort] = useState('');
  const [account, setAccount] = useState('');
  const [monzo, setMonzo] = useState('');
  const [revolut, setRevolut] = useState('');
  const [showHandles, setShowHandles] = useState(false);
  const [remember, setRemember] = useState(true);
  const [tried, setTried] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (hydrated) return;
    if (DEMO_MODE) {
      setName(DEMO_PAYOUT.accountHolderName); setSort(formatSort(DEMO_PAYOUT.sortCode)); setAccount(DEMO_PAYOUT.accountNumber);
      setHydrated(true); return;
    }
    if (stored.isPending) return;
    if (stored.data) {
      setName(stored.data.accountHolderName); setSort(formatSort(stored.data.sortCode)); setAccount(stored.data.accountNumber);
      setMonzo(stored.data.monzoHandle ?? ''); setRevolut(stored.data.revolutTag ?? '');
      if (stored.data.monzoHandle || stored.data.revolutTag) setShowHandles(true);
      setRemember(isPayoutAccountRemembered());
    }
    setHydrated(true);
  }, [hydrated, stored.isPending, stored.data]);

  const nameErr = tried && !name.trim() ? 'Whose account is this?' : null;
  const sortErr = tried && digits(sort, 6).length !== 6 ? 'Six digits' : null;
  const accErr = tried && digits(account, 8).length !== 8 ? 'Eight digits' : null;

  const onSave = async () => {
    setTried(true);
    setSubmitError(null);
    if (!name.trim() || digits(sort, 6).length !== 6 || digits(account, 8).length !== 8) return;
    try {
      await save({
        sortCode: digits(sort, 6),
        accountNumber: digits(account, 8),
        accountHolderName: name.trim(),
        ...(cleanHandle(monzo) ? { monzoHandle: cleanHandle(monzo) } : {}),
        ...(cleanHandle(revolut) ? { revolutTag: cleanHandle(revolut) } : {}),
      }, { remember });
      if (returnTo) router.replace(safeInternalPath(returnTo));
      else router.replace('/');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Couldn't save.");
    }
  };

  if (stored.isPending && !hydrated) return <Centre><Spin /></Centre>;
  const field = (err: string | null) => ({ className: 'g-input', style: { height: 50, borderColor: err ? 'rgba(255,138,128,0.6)' : undefined } });

  return (
    <Screen>
      <Backdrop tone="deep" />
      <TopBar left={<Fab href={returnTo ? safeInternalPath(returnTo) : '/'} label="Back" icon={<Back />} replace />} />
      <Sheet
        title="Where should the money land?"
        sub="Friends get these in the QR. We never see them."
        foot={<Btn type="submit" form="payout" busy={isSaving}>{returnTo ? 'Save and share the bill' : 'Save'}</Btn>}
      >
        <form id="payout" onSubmit={(e) => { e.preventDefault(); void onSave(); }} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="g-field">
            <label htmlFor="n" className="g-label" style={{ padding: 0 }}>Name on the account</label>
            <input id="n" {...field(nameErr)} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoCapitalize="words" disabled={DEMO_MODE} autoFocus={!name} />
            {nameErr ? <div className="g-error">{nameErr}</div> : null}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div className="g-field" style={{ flex: 1 }}>
              <label htmlFor="s" className="g-label" style={{ padding: 0 }}>Sort code</label>
              <input id="s" {...field(sortErr)} value={sort} onChange={(e) => setSort(formatSort(e.target.value))} inputMode="numeric" placeholder="00-00-00" maxLength={8} disabled={DEMO_MODE} />
              {sortErr ? <div className="g-error">{sortErr}</div> : null}
            </div>
            <div className="g-field" style={{ flex: 1.4 }}>
              <label htmlFor="a" className="g-label" style={{ padding: 0 }}>Account number</label>
              <input id="a" {...field(accErr)} value={account} onChange={(e) => setAccount(digits(e.target.value, 8))} inputMode="numeric" placeholder="00000000" maxLength={8} disabled={DEMO_MODE} />
              {accErr ? <div className="g-error">{accErr}</div> : null}
            </div>
          </div>

          {DEMO_MODE ? null : !showHandles ? (
            <button type="button" className="g-btn g-btn--sm" style={{ background: 'none', border: '1px dashed rgba(255,255,255,0.25)', color: 'var(--g-ink-2)' }} onClick={() => setShowHandles(true)}>
              + Monzo or Revolut for one-tap pay
            </button>
          ) : (
            <div style={{ display: 'flex', gap: 8 }}>
              <div className="g-field" style={{ flex: 1 }}>
                <label htmlFor="m" className="g-label" style={{ padding: 0 }}>monzo.me/</label>
                <input id="m" className="g-input" style={{ height: 50 }} value={monzo} onChange={(e) => setMonzo(e.target.value)} placeholder="handle" autoCapitalize="none" autoCorrect="off" />
              </div>
              <div className="g-field" style={{ flex: 1 }}>
                <label htmlFor="r" className="g-label" style={{ padding: 0 }}>revolut.me/</label>
                <input id="r" className="g-input" style={{ height: 50 }} value={revolut} onChange={(e) => setRevolut(e.target.value)} placeholder="tag" autoCapitalize="none" autoCorrect="off" />
              </div>
            </div>
          )}

          {DEMO_MODE ? null : (
            <label className="g-checkbox" style={{ background: remember ? 'rgba(61,220,151,0.1)' : undefined, border: `1px solid ${remember ? 'rgba(61,220,151,0.25)' : 'transparent'}` }}>
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>
                <span className="g-checkbox__t">Save these for next time</span>
                <span className="g-checkbox__d">Kept on this phone. Leave it off on a shared device.</span>
              </span>
            </label>
          )}
          {submitError ? <Notice error>{submitError}</Notice> : null}
        </form>
      </Sheet>
    </Screen>
  );
}
