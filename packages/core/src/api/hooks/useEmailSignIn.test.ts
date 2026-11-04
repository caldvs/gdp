import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The answers the server gives, one per call, in order.
const answers: unknown[] = [];
const calls: string[] = [];
vi.mock('../index', async (orig) => ({
  ...(await orig<typeof import('../index')>()),
  api: vi.fn((path: string) => {
    calls.push(path);
    return Promise.resolve(answers.length > 1 ? answers.shift() : answers[0]);
  }),
}));

const { useVerifyEmailCode } = await import('./useEmailSignIn');
const { getStoredToken, clearToken } = await import('../auth');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const user = { userId: 'u1', email: 'sam@example.com', displayName: 'sam' };
let root: Root;
let qc: QueryClient;
let verify: ReturnType<typeof useVerifyEmailCode>;

function Probe() {
  verify = useVerifyEmailCode();
  return null;
}

async function mount() {
  qc = new QueryClient();
  root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe)));
  });
}

const enter = (code: string) =>
  act(async () => verify.mutateAsync({ requestId: 'req.1', code }));

beforeEach(async () => {
  answers.length = 0;
  calls.length = 0;
  await clearToken();
  await mount();
});
afterEach(() => {
  act(() => root.unmount());
  qc.clear();
});

describe('useVerifyEmailCode', () => {
  it('signedIn keeps the session and sets who is signed in', async () => {
    answers.push({ status: 'signedIn', token: 't1', user });
    const res = await enter('123456');
    expect(res.status).toBe('signedIn');
    expect(calls).toEqual(['/v1/auth/email/verify']);
    expect(await getStoredToken()).toBe('t1');
    expect(qc.getQueryData(['me'])).toEqual(user);
  });

  it('a wrong code keeps nothing and says how many tries are left', async () => {
    answers.push({ status: 'wrong', attemptsLeft: 3 });
    expect(await enter('000000')).toEqual({ status: 'wrong', attemptsLeft: 3 });
    expect(await getStoredToken()).toBeNull();
  });

  it('expired keeps nothing', async () => {
    answers.push({ status: 'expired' });
    expect(await enter('000000')).toEqual({ status: 'expired' });
    expect(await getStoredToken()).toBeNull();
  });
});
