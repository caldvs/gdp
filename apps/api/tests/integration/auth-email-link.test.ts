import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { createSessionTokenVerifier } from '../../src/services/auth.js';
import type { EmailSender, SendEmailInput } from '../../src/services/email/sender.js';
import { v7 as uuidv7 } from 'uuid';

const SECRET = new TextEncoder().encode('test-secret-must-be-at-least-16-bytes');

class CapturingEmailSender implements EmailSender {
  readonly provider = 'capture';
  readonly sent: SendEmailInput[] = [];
  send(input: SendEmailInput): Promise<void> {
    this.sent.push(input);
    return Promise.resolve();
  }
}

type App = ReturnType<typeof buildApp>['app'];
type User = { userId: string; email: string; displayName: string };
type Status = { status: 'pending' | 'signedIn' | 'expired'; token?: string; user?: User };

function uniqueEmail(): string {
  return `user-${uuidv7()}@example.com`;
}

/** The link in the email, and the token in its fragment. */
function extractLink(email: SendEmailInput): { url: string; token: string } {
  const m = email.body.text.match(/(\S+\/sign-in\/verify#t=(\S+))/);
  if (!m) throw new Error(`No sign-in link in email body: ${email.body.text}`);
  return { url: m[1]!, token: m[2]! };
}

function buildApp(opts: { allowedOrigins?: string } = {}) {
  const sender = new CapturingEmailSender();
  const app = createApp({
    emailSender: sender,
    sessionJwtSecret: SECRET,
    idTokenVerifier: createSessionTokenVerifier(SECRET),
    ...(opts.allowedOrigins !== undefined ? { allowedOrigins: opts.allowedOrigins } : {}),
  });
  return { app, sender };
}

const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const start = (app: App, email: string, headers?: Record<string, string>) =>
  post(app, '/v1/auth/email/start', { email }, headers);
const openLink = (app: App, token: string) => post(app, '/v1/auth/email/link', { token });
const poll = async (app: App, requestId: string): Promise<Status> =>
  (await (await post(app, '/v1/auth/email/requests', { requestId })).json()) as Status;

/** Start a sign-in; return the waiting tab's requestId and the emailed token. */
async function begin(app: App, sender: CapturingEmailSender, email = uniqueEmail()) {
  const res = await start(app, email);
  expect(res.status).toBe(200);
  const { requestId } = (await res.json()) as { requestId: string };
  return { email, requestId, token: extractLink(sender.sent.at(-1)!).token };
}

afterEach(() => vi.useRealTimers());

describe('POST /v1/auth/email/start', () => {
  it('emails a sign-in link and returns a requestId, not the token', async () => {
    const { app, sender } = buildApp();
    const email = uniqueEmail();
    const res = await start(app, email);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: true; requestId: string };
    expect(body.ok).toBe(true);
    expect(body.requestId).toMatch(/^[\w-]{22}\.[\w-]{43}$/);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.to).toBe(email);
    const { url, token } = extractLink(sender.sent[0]!);
    expect(url.startsWith('http://localhost:8081/sign-in/verify#t=')).toBe(true);
    expect(token).not.toBe(body.requestId);
    expect(sender.sent[0]?.body.html).toContain(url);
  });

  it('points the link at the calling origin when it is allowed, else APP_BASE_URL', async () => {
    const { app, sender } = buildApp({ allowedOrigins: 'https://test.paymeback.dev' });
    await start(app, uniqueEmail(), { origin: 'https://test.paymeback.dev' });
    expect(extractLink(sender.sent[0]!).url).toMatch(/^https:\/\/test\.paymeback\.dev\/sign-in/);
    await start(app, uniqueEmail(), { origin: 'https://evil.example' });
    expect(extractLink(sender.sent[1]!).url).toMatch(/^http:\/\/localhost:8081\/sign-in/);
  });

  it('still answers 200 with a requestId when the email fails to send', async () => {
    const app = createApp({
      emailSender: { provider: 'none', send: () => Promise.reject(new Error('SES down')) },
      sessionJwtSecret: SECRET,
      idTokenVerifier: createSessionTokenVerifier(SECRET),
    });
    const res = await start(app, uniqueEmail());
    expect(res.status).toBe(200);
    expect(((await res.json()) as { requestId?: string }).requestId).toBeTruthy();
  });

  it('rejects malformed emails with 400 INVALID_INPUT', async () => {
    const { app } = buildApp();
    expect((await start(app, 'not an email')).status).toBe(400);
  });
});

describe('POST /v1/auth/email/link', () => {
  it('signs the link tab in, and the token authenticates /v1/me', async () => {
    const { app, sender } = buildApp();
    const { email, token } = await begin(app, sender);
    const res = await openLink(app, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; user: User };
    expect(body.token.split('.')).toHaveLength(3);
    expect(body.user.email).toBe(email);
    expect(body.user.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.user.displayName).toBe(email.split('@')[0]);

    const me = await app.request('/v1/me', { headers: { authorization: `Bearer ${body.token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { email: string }).email).toBe(email);
  });

  it('works once: opening it again is 401 AUTH_INVALID', async () => {
    const { app, sender } = buildApp();
    const { token } = await begin(app, sender);
    expect((await openLink(app, token)).status).toBe(200);
    const again = await openLink(app, token);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('AUTH_INVALID');
  });

  it('expires after 15 minutes', async () => {
    const { app, sender } = buildApp();
    const { token, requestId } = await begin(app, sender);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 15 * 60_000 + 1_000);
    expect((await openLink(app, token)).status).toBe(401);
    expect(await poll(app, requestId)).toEqual({ status: 'expired' });
  });

  it('a wrong secret, an unknown id or a junk token is 401 and spends nothing', async () => {
    const { app, sender } = buildApp();
    const { token } = await begin(app, sender);
    const [id, secret] = token.split('.') as [string, string];
    const flipped = `${id}.${secret[0] === 'A' ? 'B' : 'A'}${secret.slice(1)}`;
    expect((await openLink(app, flipped)).status).toBe(401);
    expect((await openLink(app, `${'x'.repeat(22)}.${secret}`)).status).toBe(401);
    expect((await openLink(app, 'nonsense')).status).toBe(401);
    // The real link still works after those.
    expect((await openLink(app, token)).status).toBe(200);
  });

  it('the requestId is not a link token', async () => {
    const { app, sender } = buildApp();
    const { requestId } = await begin(app, sender);
    expect((await openLink(app, requestId)).status).toBe(401);
  });

  it('the same email gets the same account each time', async () => {
    const { app, sender } = buildApp();
    const email = uniqueEmail();
    const a = await begin(app, sender, email);
    const u1 = ((await (await openLink(app, a.token)).json()) as { user: User }).user;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    const b = await begin(app, sender, email);
    const u2 = ((await (await openLink(app, b.token)).json()) as { user: User }).user;
    expect(u2.userId).toBe(u1.userId);
  });
});

describe('POST /v1/auth/email/requests (the tab that asked)', () => {
  it('pending until the link is opened, then signed in once, then expired', async () => {
    const { app, sender } = buildApp();
    const { email, requestId, token } = await begin(app, sender);
    expect(await poll(app, requestId)).toEqual({ status: 'pending' });

    const linkUser = ((await (await openLink(app, token)).json()) as { user: User }).user;
    const signedIn = await poll(app, requestId);
    expect(signedIn.status).toBe('signedIn');
    expect(signedIn.user).toEqual(linkUser);
    const me = await app.request('/v1/me', {
      headers: { authorization: `Bearer ${signedIn.token}` },
    });
    expect(((await me.json()) as { email: string }).email).toBe(email);

    expect(await poll(app, requestId)).toEqual({ status: 'expired' });
  });

  it('a wrong requestId never gets the session, even after the link is opened', async () => {
    const { app, sender } = buildApp();
    const { requestId, token } = await begin(app, sender);
    await openLink(app, token);
    const [id] = requestId.split('.') as [string];
    expect(await poll(app, `${id}.${'A'.repeat(43)}`)).toEqual({ status: 'expired' });
    // The link's own token can't collect it either.
    expect(await poll(app, token)).toEqual({ status: 'expired' });
    expect(await poll(app, 'nonsense')).toEqual({ status: 'expired' });
    // The real one still can.
    expect((await poll(app, requestId)).status).toBe('signedIn');
  });

  it('a link opened at minute 14 still signs the waiting tab in a little later', async () => {
    const { app, sender } = buildApp();
    const { requestId, token } = await begin(app, sender);
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0 + 14 * 60_000);
    expect((await openLink(app, token)).status).toBe(200);
    vi.setSystemTime(t0 + 16 * 60_000);
    expect((await poll(app, requestId)).status).toBe('signedIn');
  });

  it('400 without a requestId', async () => {
    const { app } = buildApp();
    expect((await post(app, '/v1/auth/email/requests', {})).status).toBe(400);
  });
});

describe('POST /v1/auth/email/start: sending limits (#76)', () => {
  it('one link every 30 seconds: a second ask is refused and the first link still works', async () => {
    const { app, sender } = buildApp();
    const { email, token } = await begin(app, sender);
    const again = await start(app, email);
    expect(again.status).toBe(429);
    const body = (await again.json()) as {
      error: { code: string; details: { retryAfterSeconds: number } };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details.retryAfterSeconds).toBe(30);
    expect(sender.sent).toHaveLength(1);
    expect((await openLink(app, token)).status).toBe(200);
  });

  it('at most 5 links in 15 minutes per address; other addresses are unaffected', async () => {
    const { app, sender } = buildApp();
    const email = uniqueEmail();
    // Start of a 15-minute window, then 31 seconds between asks.
    const t0 = Math.ceil(Date.now() / 900_000) * 900_000 + 1_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let i = 0; i < 5; i += 1) {
      vi.setSystemTime(t0 + i * 31_000);
      expect((await start(app, email)).status).toBe(200);
    }
    vi.setSystemTime(t0 + 5 * 31_000);
    const sixth = await start(app, email);
    expect(sixth.status).toBe(429);
    expect(((await sixth.json()) as { error: { message: string } }).error.message).toMatch(
      /Too many links/,
    );
    expect(sender.sent).toHaveLength(5);
    expect((await start(app, uniqueEmail())).status).toBe(200);
  });
});
