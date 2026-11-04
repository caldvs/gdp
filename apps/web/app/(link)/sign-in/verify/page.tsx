'use client';

import { useEffect, useRef, useState } from 'react';
import { useDenySignInLink, useOpenSignInLink, useSignInLinkCode } from '@gdp/core/api/hooks/useEmailSignIn';
import { takeReturnTo } from '@/lib/signInReturn';
import { Button, Centre, Page, Spinner, Title } from '@/components/ui';

type State =
  | { kind: 'opening' }
  | { kind: 'confirm'; token: string; code: string }
  | { kind: 'signedIn'; next: string }
  | { kind: 'denied' }
  | { kind: 'expired' };

/** The token from `#t=…`, and the fragment wiped so it isn't left in history. */
function takeToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  return token;
}

/**
 * Where an emailed sign-in link lands. First it asks whether the tab that
 * asked shows the same number (#138), so a sign-in someone else started
 * can't be finished by tapping a genuine email. Yes signs this tab in and
 * the tab that asked carries on by itself; No cancels it.
 */
export default function VerifyLinkPage() {
  const linkCode = useSignInLinkCode();
  const openLink = useOpenSignInLink();
  const deny = useDenySignInLink();
  const [state, setState] = useState<State>({ kind: 'opening' });
  // Read the fragment once (React re-runs effects in dev).
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const token = takeToken();
    if (!token) {
      setState({ kind: 'expired' });
      return;
    }
    linkCode.mutate(
      { token },
      {
        onSuccess: ({ code }) => setState({ kind: 'confirm', token, code }),
        onError: () => setState({ kind: 'expired' }),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.kind === 'opening') return <Centre><Spinner label="Opening link" /></Centre>;

  if (state.kind === 'confirm') {
    const { token, code } = state;
    const yes = () =>
      openLink.mutate(
        { token, code },
        {
          onSuccess: () => setState({ kind: 'signedIn', next: takeReturnTo() }),
          onError: () => setState({ kind: 'expired' }),
        },
      );
    const no = () => deny.mutate({ token }, { onSettled: () => setState({ kind: 'denied' }) });
    return (
      <Page>
        <Title title={`Signing in the tab showing ${code}?`} />
        <div className="btn-row">
          <Button tone="secondary" busy={deny.isPending} disabled={openLink.isPending} onClick={no}>No</Button>
          <Button grow busy={openLink.isPending} disabled={deny.isPending} onClick={yes}>Yes</Button>
        </div>
      </Page>
    );
  }

  if (state.kind === 'denied') {
    return (
      <Page>
        <Title title="Not signed in" sub="Someone else asked. Ignore the email." />
        <Button href="/sign-in" replace tone="secondary">Sign in</Button>
      </Page>
    );
  }

  if (state.kind === 'expired') {
    return (
      <Page>
        <Title title="Link expired" />
        <Button href="/sign-in/email" replace>Send a new link</Button>
      </Page>
    );
  }

  return (
    <Page>
      <Title title="Signed in" sub="Go back to your other tab." />
      <Button href={state.next} replace tone="secondary">Continue here</Button>
    </Page>
  );
}
