import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The answers the server gives, one per poll, in order.
const answers: unknown[] = [];
const calls: string[] = [];
vi.mock('../index', async (orig) => ({
  ...(await orig<typeof import('../index')>()),
  api: vi.fn((path: string) => {
    calls.push(path);
    return Promise.resolve(answers.length > 1 ? answers.shift() : answers[0]);
  }),
}));

const { useSignInRequest } = await import('./useEmailSignIn');
const { getStoredToken, clearToken } = await import('../auth');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = { userId: 'u1', email: 'sam@example.com', displayName: 'sam' };
let seen: (string | undefined)[] = [];
let root: Root;
let qc: QueryClient;
let refetch: () => Promise<unknown>;

function Probe({ requestId }: { requestId: string | null }) {
  const q = useSignInRequest(requestId);
  refetch = q.refetch;
  seen.push(q.data?.status);
  return null;
}

async function mount(requestId: string | null) {
  qc = new QueryClient();
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe, { requestId })));
  });
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(async () => {
  answers.length = 0;
  calls.length = 0;
  seen = [];
  await clearToken();
});
afterEach(() => {
  act(() => root.unmount());
  qc.clear();
});

describe('useSignInRequest', () => {
  it('waits while pending', async () => {
    answers.push({ status: 'pending' });
    await mount('req.1');
    await flush();
    expect(seen.at(-1)).toBe('pending');
    expect(await getStoredToken()).toBeNull();
  });

  it('signedIn keeps the session and stops polling', async () => {
    answers.push({ status: 'signedIn', token: 't1', user });
    await mount('req.1');
    await flush();
    await flush();
    expect(seen.at(-1)).toBe('signedIn');
    expect(await getStoredToken()).toBe('t1');
    const n = calls.length;
    await act(async () => { await refetch(); });
    await flush();
    // A disabled query doesn't poll on its own; and the hook still says signed in.
    expect(seen.at(-1)).toBe('signedIn');
    expect(calls.length - n).toBeLessThanOrEqual(1);
  });

  // 4 Nov 2026: a second, overlapping poll answered `expired` after the
  // first had signed the tab in, and the page said "Link expired".
  it('a later `expired` never replaces `signedIn`', async () => {
    answers.push({ status: 'signedIn', token: 't1', user }, { status: 'expired' });
    await mount('req.1');
    await flush();
    await flush();
    expect(seen.at(-1)).toBe('signedIn');
    await act(async () => { await refetch(); });
    await flush();
    expect(seen.at(-1)).toBe('signedIn');
    expect(seen).not.toContain('expired');
    expect(await getStoredToken()).toBe('t1');
  });

  it('expired before any sign-in is expired', async () => {
    answers.push({ status: 'expired' });
    await mount('req.1');
    await flush();
    expect(seen.at(-1)).toBe('expired');
    expect(await getStoredToken()).toBeNull();
  });

  it('does nothing without a requestId', async () => {
    await mount(null);
    await flush();
    expect(calls).toEqual([]);
    expect(seen.at(-1)).toBeUndefined();
  });
});
