'use client';

import { useEffect, useState } from 'react';
import { ApiError } from '@gdp/core/api';
import { clearToken, isTabSignedIn } from '@gdp/core/api/auth';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { useTestAccountSignIn } from '@gdp/core/api/hooks/useEmailSignIn';
import { getSkipReadCache, setSkipReadCache } from '@gdp/core/lib/skipReadCache';
import { newGuestName, TEST_ACCOUNT_NAMES, testAccountEmail } from '@gdp/core/lib/testAccounts';
import { TEST_TOOLS_ENABLED, WEB_APP_ENV } from '@/lib/config';
import { Button } from './ui';

const TAB_ONLY_KEY = 'gdp.test.tabOnly';

/**
 * Local and dev only: shows which account this tab is, and signs in as a
 * test account (@test.invalid, no code). "This tab" keeps the switch to
 * this tab, so the lead and a guest can sit side by side in one window.
 * Local only: "Skip bill cache" reads a photo with the model again even
 * if this account has read it before.
 *
 * `reload`: reload the page after switching (signed-in screens, so every
 * query starts again as the new user). Off on sign-in, which moves on by
 * itself once someone is signed in.
 */
export function TestBar({ open: startOpen = false, reload = true }: { open?: boolean; reload?: boolean }) {
  if (!TEST_TOOLS_ENABLED) return null;
  return <Bar startOpen={startOpen} reload={reload} />;
}

function Bar({ startOpen, reload }: { startOpen: boolean; reload: boolean }) {
  const me = useMe();
  const signIn = useTestAccountSignIn();
  const [open, setOpen] = useState(startOpen);
  const [tabOnly, setTabOnly] = useState(true);
  const [tabSignedIn, setTabSignedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skipCache, setSkipCache] = useState(false);

  useEffect(() => {
    setTabSignedIn(isTabSignedIn());
    try {
      setTabOnly(window.localStorage.getItem(TAB_ONLY_KEY) !== '0');
    } catch {}
    setSkipCache(getSkipReadCache());
  }, [me.data?.userId]);

  const chooseTabOnly = (v: boolean) => {
    setTabOnly(v);
    try { window.localStorage.setItem(TAB_ONLY_KEY, v ? '1' : '0'); } catch {}
  };

  const chooseSkipCache = (v: boolean) => {
    setSkipCache(v);
    setSkipReadCache(v);
  };

  const signInAs = async (name: string) => {
    setError(null);
    try {
      await signIn.mutateAsync({ email: testAccountEmail(name), tabOnly });
      if (reload) window.location.reload();
      else setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'Test accounts are off on this API.' : 'Couldn’t sign in.');
    }
  };

  const leaveTab = async () => {
    await clearToken();
    window.location.reload();
  };

  const who = me.data?.email ?? 'Signed out';

  return (
    <div className="testbar" role="region" aria-label="Test tools">
      <div className="testbar__in">
        <div className="testbar__top">
          <span className="testbar__tag">Test · {WEB_APP_ENV}</span>
          <span className="testbar__who">{who}{tabSignedIn ? ' · this tab' : ''}{skipCache ? ' · no cache' : ''}</span>
          <button type="button" className="testbar__toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? 'Close' : 'Switch'}
          </button>
        </div>
        {open ? (
          <div className="testbar__body">
            <div className="testbar__people">
              {TEST_ACCOUNT_NAMES.map((n) => (
                <Button key={n} tone="secondary" small disabled={signIn.isPending} onClick={() => void signInAs(n)}>{n}</Button>
              ))}
              <Button tone="secondary" small disabled={signIn.isPending} onClick={() => void signInAs(newGuestName())}>New guest</Button>
            </div>
            <label className="testbar__check">
              <input type="checkbox" checked={tabOnly} onChange={(e) => chooseTabOnly(e.target.checked)} />
              This tab only
            </label>
            {WEB_APP_ENV === 'local' ? (
              <label className="testbar__check">
                <input type="checkbox" checked={skipCache} onChange={(e) => chooseSkipCache(e.target.checked)} />
                Skip bill cache
              </label>
            ) : null}
            {tabSignedIn ? (
              <Button tone="text" small onClick={() => void leaveTab()}>Leave test account in this tab</Button>
            ) : null}
            {error ? <div className="field__err">{error}</div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
