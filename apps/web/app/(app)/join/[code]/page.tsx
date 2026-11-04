'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, ApiError, type components } from '@gdp/core/api';
import { scrubFragmentFromUrl, storeSessionPayoutFromFragment } from '@gdp/core/lib/sessionPayout';
import { takeJoinFragment } from '@/lib/joinFragment';
import { ActionBar, Button, Notice, Page, Spinner, Title } from '@/components/ui';

type Session = components['schemas']['Session'];

// Captured once per page load: effects can run twice (React dev mode),
// and the first run scrubs the fragment from the address bar.
let captured: { code: string; fragment: string | null } | null = null;
function captureFragment(code: string): string | null {
  if (captured?.code !== code) {
    captured = { code, fragment: window.location.hash || takeJoinFragment() };
  }
  return captured.fragment;
}
type State =
  | { kind: 'resolving' }
  | { kind: 'joining'; sessionId: string }
  | { kind: 'done'; sessionId: string }
  | { kind: 'error'; message: string };

export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'resolving' });

  useEffect(() => {
    if (!code) {
      setState({ kind: 'error', message: 'No code provided' });
      return;
    }
    // Old 6-letter codes were typed in any case; new tokens are case-sensitive (#182).
    const raw = decodeURIComponent(code);
    const normalized = /^[a-z0-9]{6}$/i.test(raw) ? raw.toUpperCase() : raw;
    let cancelled = false;
    (async () => {
      try {
        // The lead's bank details ride in the #p= fragment (never sent to
        // a server). Read it before scrubbing it from the address bar —
        // or from the stash if we came back here via sign-in.
        const fragment = captureFragment(normalized);
        scrubFragmentFromUrl();
        const resolved = await api<{ sessionId: string }>('/v1/sessions/by-code', { method: 'POST', body: { code: normalized } });
        if (cancelled) return;
        if (fragment) storeSessionPayoutFromFragment(resolved.sessionId, fragment);
        setState({ kind: 'joining', sessionId: resolved.sessionId });
        await api<Session>(`/v1/sessions/${resolved.sessionId}/join`, { method: 'POST' });
        if (cancelled) return;
        setState({ kind: 'done', sessionId: resolved.sessionId });
        router.replace(`/session/${resolved.sessionId}`);
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: 'error',
          message: e instanceof ApiError
            ? e.code === 'NOT_FOUND' ? "We couldn’t find that bill. Ask whoever paid to show their QR again."
              : e.code === 'SESSION_INVALID_STATE' && (e.details as { status?: string } | undefined)?.status === 'settled' ? 'This bill’s already closed. Ask the host if you still owe.'
              : e.message
            : (e as Error)?.message ?? 'Could not join',
        });
      }
    })();
    return () => { cancelled = true; };
  }, [code, router]);

  return (
    <>
      <Page>
        <Title title={state.kind === 'error' ? 'Couldn’t join' : 'Joining…'} />
        {state.kind === 'error' ? <Notice tone="error">{state.message}</Notice> : <Spinner label="Joining" />}
      </Page>
      {state.kind === 'error' ? <ActionBar><Button grow href="/" replace>Back to Bills</Button></ActionBar> : null}
    </>
  );
}
