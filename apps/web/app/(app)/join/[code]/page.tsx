'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, type components } from '@gdp/core/api';
import { storeToken } from '@gdp/core/api/auth';
import { useMe } from '@gdp/core/api/hooks/useMe';
import { formatGBP } from '@gdp/core/lib/money';
import { scrubFragmentFromUrl, storeSessionPayoutFromFragment } from '@gdp/core/lib/sessionPayout';
import { takeJoinFragment } from '@/lib/joinFragment';
import { ActionBar, Button, Centre, Notice, Page, Spinner, Title } from '@/components/ui';

type Session = components['schemas']['Session'];
type Preview = components['schemas']['SessionPreview'];

/** Old 6-letter codes were typed in any case; new tokens are case-sensitive (#182). */
function normalise(code: string): string {
  const raw = decodeURIComponent(code);
  return /^[a-z0-9]{6}$/i.test(raw) ? raw.toUpperCase() : raw;
}

const joinError = (e: unknown): string =>
  e instanceof ApiError
    ? e.code === 'NOT_FOUND' ? 'We couldn’t find that bill. Ask whoever paid to show their QR again.'
      : e.code === 'SESSION_INVALID_STATE' && (e.details as { status?: string } | undefined)?.status === 'settled' ? 'This bill’s already closed. Ask the host if you still owe.'
      : e.message
    : (e as Error)?.message ?? 'Could not join';

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

/**
 * What the QR opens. A guest (not signed in) sees the bill and joins with
 * just a name (#183); someone signed in is seated at once.
 */
export default function JoinPage() {
  const { code } = useParams<{ code: string }>();
  const me = useMe({ refetchOnMount: false });
  const status = me.error instanceof ApiError ? me.error.status : 0;
  if (me.isPending) return <Centre><Spinner /></Centre>;
  if (me.isError && (status === 401 || status === 403)) return <GuestLanding code={normalise(code ?? '')} />;
  return <SignedInJoin />;
}

function SignedInJoin() {
  const { code } = useParams<{ code: string }>();
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: 'resolving' });

  useEffect(() => {
    if (!code) {
      setState({ kind: 'error', message: 'No code provided' });
      return;
    }
    const normalized = normalise(code);
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
        setState({ kind: 'error', message: joinError(e) });
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

/**
 * The QR's landing page for a guest (#183): who invited them, the bill,
 * how it works, and their name. Guests never sign in: joining gives them a
 * token for this one bill.
 */
function GuestLanding({ code }: { code: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Park the bank details before the address bar is scrubbed.
  const [fragment] = useState(() => (typeof window === 'undefined' ? null : captureFragment(code)));
  useEffect(() => { scrubFragmentFromUrl(); }, []);
  const preview = useQuery<Preview, ApiError>({
    queryKey: ['preview', code],
    queryFn: () => api<Preview>('/v1/sessions/preview', { method: 'POST', body: { code } }),
    retry: false,
  });

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) { setError('Add your name'); return; }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string; session: Session }>('/v1/sessions/guest-join', { method: 'POST', body: { code, name: n } });
      await storeToken(res.token);
      if (fragment) storeSessionPayoutFromFragment(res.session.sessionId, fragment);
      await qc.invalidateQueries({ queryKey: ['me'] });
      qc.setQueryData(['session', res.session.sessionId], res.session);
      router.replace(`/session/${res.session.sessionId}`);
    } catch (err) {
      setError(joinError(err));
      setBusy(false);
    }
  };

  if (preview.isPending) return <Centre><Spinner /></Centre>;
  if (preview.isError || preview.data.status !== 'claiming') {
    const closed = preview.data?.status === 'settled' || preview.data?.status === 'paying';
    return (
      <>
        <Page>
          <Title title="Couldn’t join" />
          <Notice tone="error">{closed ? 'This bill’s already closed. Ask whoever paid if you still owe.' : 'We couldn’t find that bill. Ask whoever paid to show their QR again.'}</Notice>
        </Page>
      </>
    );
  }
  const p = preview.data;
  const others = p.people.slice(1);
  const inNow = others.length === 0 ? `${p.hostName} is waiting` : others.length === 1 ? `${others[0]} is in` : `${others.slice(0, -1).join(', ')} and ${others.at(-1)} are in`;
  const date = new Date(p.createdAt).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  return (
    <>
      <div className="join-hero">
        <div className="join-hero__in">
          <h1 className="join-hero__h">Join {p.hostName}’s bill</h1>
          <div className="join-hero__who">{inNow}</div>
        </div>
      </div>
      <Page>
        <section className="join-card" aria-label="The bill">
          <div className="join-card__top">
            <div>
              <div className="join-card__venue">{p.venueName ?? `${p.hostName}’s bill`}</div>
              <div className="small muted">{date} · {p.itemCount} {p.itemCount === 1 ? 'item' : 'items'}</div>
            </div>
            <div className="join-card__total">
              <b>{formatGBP(p.totalPence)}</b>
              <span className="small muted">incl. service</span>
            </div>
          </div>
          <ol className="join-steps">
            <li><span aria-hidden="true">1</span>Tap what you had</li>
            <li><span aria-hidden="true">2</span>See your share</li>
            <li><span aria-hidden="true">3</span>Pay {p.hostName} back</li>
          </ol>
        </section>
        <form id="guest-join" className="field" onSubmit={join}>
          <label htmlFor="guest-name">Your name</label>
          <input id="guest-name" className="input input--name" value={name} onChange={(e) => { setName(e.target.value); if (error) setError(null); }} autoComplete="given-name" enterKeyHint="go" maxLength={40} />
          <span className="small muted">No app, no account. {p.hostName} just sees your name.</span>
        </form>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </Page>
      <ActionBar>
        <Button grow type="submit" form="guest-join" busy={busy}>Join the bill</Button>
      </ActionBar>
    </>
  );
}

