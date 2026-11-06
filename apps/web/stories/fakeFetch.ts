/**
 * Storybook's API: the e2e suite's in-memory fake (e2e/fakeCore.ts) answers
 * every /v1/ request, so a screen story renders the real page and its
 * buttons work. One fake at a time: each story installs its own.
 */
import { FakeCore, type User } from '../e2e/fakeCore';

let current: { api: FakeCore; user: User } | null = null;
let realFetch: typeof fetch | null = null;

export function installFake(api: FakeCore, user: User): void {
  current = { api, user };
  // Signed in, and active just now, so the shell doesn't sign them out.
  localStorage.setItem('gdp.idToken', 'test-token');
  localStorage.setItem('gdp.lastActiveAt', String(Date.now()));
  if (realFetch) return;
  realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    if (!current || !url.pathname.startsWith('/v1/')) return realFetch!(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = typeof init?.body === 'string' ? init.body : null;
    const reply = current.api.respond(
      {
        method: (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase(),
        path: url.pathname,
        body,
        authorization: headers.get('authorization') ?? undefined,
      },
      current.user,
    );
    return new Response(reply.status === 204 ? null : reply.body, {
      status: reply.status,
      headers: { 'content-type': reply.contentType },
    });
  };
}

/** Act on the fake as someone at the table, the way the app would. */
export function as(api: FakeCore, user: User) {
  const send = (method: string, path: string, body?: unknown) => {
    const reply = api.respond({ method, path, body: body === undefined ? null : JSON.stringify(body), authorization: 'Bearer test-token' }, user);
    if (reply.status >= 400) throw new Error(`${method} ${path}: ${reply.body}`);
    return reply.body ? (JSON.parse(reply.body) as Record<string, unknown>) : {};
  };
  return {
    post: (path: string, body?: unknown) => send('POST', path, body),
  };
}
