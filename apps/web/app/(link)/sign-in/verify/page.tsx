'use client';

import { useEffect, useRef, useState } from 'react';
import { useOpenSignInLink } from '@gdp/core/api/hooks/useEmailSignIn';
import { takeReturnTo } from '@/lib/signInReturn';
import { Button, Centre, Page, Spinner, Title } from '@/components/ui';

type State = { kind: 'opening' } | { kind: 'signedIn'; next: string } | { kind: 'expired' };

/** The token from `#t=…`, and the fragment wiped so it isn't left in history. */
function takeToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('t');
  if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  return token;
}

/**
 * Where an emailed sign-in link lands. Signs this tab in, and the tab that
 * asked carries on by itself, so this one just says to go back to it.
 */
export default function VerifyLinkPage() {
  const openLink = useOpenSignInLink();
  const [state, setState] = useState<State>({ kind: 'opening' });
  // A link works once: never send it twice (React re-runs effects in dev).
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const token = takeToken();
    if (!token) {
      setState({ kind: 'expired' });
      return;
    }
    openLink.mutate(
      { token },
      {
        onSuccess: () => setState({ kind: 'signedIn', next: takeReturnTo() }),
        onError: () => setState({ kind: 'expired' }),
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (state.kind === 'opening') return <Centre><Spinner label="Signing in" /></Centre>;

  if (state.kind === 'expired') {
    return (
      <Page>
        <Title title="Link expired" />
        <Button href="/sign-in" replace>Send a new link</Button>
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
