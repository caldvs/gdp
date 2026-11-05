'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { usePayoutAccount, useSavePayoutAccount } from '@gdp/core/lib/usePayoutAccount';
import { isPayoutAccountRemembered } from '@gdp/core/lib/payoutAccount';
import { cleanHandle } from '@gdp/core/lib/quickPay';
import { DEMO_MODE, DEMO_PAYOUT } from '@gdp/core/lib/demoMode';
import { safeInternalPath } from '@gdp/core/lib/redirect';
import { ActionBar, BackLink, Button, Centre, Notice, Page, Spinner, Title } from '@/components/ui';

const digits = (s: string, max: number) => s.replace(/\D/g, '').slice(0, max);
function formatSort(raw: string): string {
  const d = digits(raw, 6);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}`;
}

export default function PayoutAccountPage() {
  return <Suspense fallback={<Centre><Spinner /></Centre>}><PayoutForm /></Suspense>;
}

/**
 * Bank details: three fields, optional Monzo/Revolut,
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

  if (stored.isPending && !hydrated) return <Centre><Spinner /></Centre>;
  const back = returnTo ? safeInternalPath(returnTo) : '/';
  const cls = (err: string | null) => (err ? 'input input--invalid' : 'input');

  return (
    <>
      <Page sub>
        <BackLink href={back}>Back</BackLink>
        <Title title="Bank details" sub="Where friends send your money. It goes in the QR code; we never see it." />
        <form id="payout" onSubmit={(e) => { e.preventDefault(); void onSave(); }} noValidate style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div className="field">
            <label htmlFor="n">Name on the account</label>
            <input id="n" className={cls(nameErr)} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoCapitalize="words" disabled={DEMO_MODE} autoFocus={!name} aria-invalid={!!nameErr} aria-describedby={nameErr ? 'n-err' : undefined} />
            {nameErr ? <div id="n-err" className="field__err">{nameErr}</div> : null}
          </div>
          <div className="editor__row" style={{ alignItems: 'flex-start' }}>
            <div className="field" style={{ flex: 1, minWidth: 0 }}>
              <label htmlFor="s">Sort code</label>
              <input id="s" className={cls(sortErr)} value={sort} onChange={(e) => setSort(formatSort(e.target.value))} inputMode="numeric" placeholder="00-00-00" maxLength={8} disabled={DEMO_MODE} aria-invalid={!!sortErr} aria-describedby={sortErr ? 's-err' : undefined} />
              {sortErr ? <div id="s-err" className="field__err">{sortErr}</div> : null}
            </div>
            <div className="field" style={{ flex: 1.4, minWidth: 0 }}>
              <label htmlFor="a">Account number</label>
              <input id="a" className={cls(accErr)} value={account} onChange={(e) => setAccount(digits(e.target.value, 8))} inputMode="numeric" placeholder="00000000" maxLength={8} disabled={DEMO_MODE} aria-invalid={!!accErr} aria-describedby={accErr ? 'a-err' : undefined} />
              {accErr ? <div id="a-err" className="field__err">{accErr}</div> : null}
            </div>
          </div>

          {DEMO_MODE ? null : !showHandles ? (
            <Button tone="text" onClick={() => setShowHandles(true)} style={{ justifyContent: 'flex-start', padding: 0 }}>Add Monzo or Revolut (optional)</Button>
          ) : (
            <>
              <div className="field">
                <label htmlFor="m">Monzo username</label>
                <div className="input affix"><span>monzo.me/</span><input id="m" value={monzo} onChange={(e) => setMonzo(e.target.value)} autoCapitalize="none" autoCorrect="off" /></div>
              </div>
              <div className="field">
                <label htmlFor="r">Revolut username</label>
                <div className="input affix"><span>revolut.me/</span><input id="r" value={revolut} onChange={(e) => setRevolut(e.target.value)} autoCapitalize="none" autoCorrect="off" /></div>
              </div>
            </>
          )}

          {DEMO_MODE ? null : (
            <label className="check">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>
                Save these for next time
                <span className="field__hint" style={{ display: 'block' }}>Kept on this device. Leave it off on a shared one.</span>
              </span>
            </label>
          )}
          {submitError ? <Notice tone="error">{submitError}</Notice> : null}
        </form>
      </Page>
      <ActionBar>
        <Button type="submit" form="payout" grow busy={isSaving}>{returnTo ? 'Save and continue' : 'Save'}</Button>
      </ActionBar>
    </>
  );
}
