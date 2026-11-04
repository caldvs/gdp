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
type Entered =
  | { status: 'signedIn'; token: string; user: User }
  | { status: 'wrong'; attemptsLeft: number }
  | { status: 'expired' };

const uniqueEmail = () => `user-${uuidv7()}@example.com`;

/** The code in the email's subject (it shows in the notification). */
function codeOf(email: SendEmailInput): string {
  const m = /^(\d{6}) is your Pay Me Back code$/.exec(email.subject);
  if (!m) throw new Error(`No code in subject: ${email.subject}`);
  return m[1]!;
}

function buildApp() {
  const sender = new CapturingEmailSender();
  const app = createApp({
    emailSender: sender,
    sessionJwtSecret: SECRET,
    idTokenVerifier: createSessionTokenVerifier(SECRET),
  });
  return { app, sender };
}

const post = (
  app: App,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  lambdaEnv?: unknown,
) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    lambdaEnv,
  );

/** What API Gateway (HTTP API) hands the Lambda: the caller's IP. */
const fromIp = (sourceIp: string) => ({ requestContext: { http: { sourceIp } } });

const start = (app: App, email: string, headers?: Record<string, string>, lambdaEnv?: unknown) =>
  post(app, '/v1/auth/email/start', { email }, headers, lambdaEnv);
const enter = async (app: App, requestId: string, code: string): Promise<Entered> => {
  const res = await post(app, '/v1/auth/email/verify', { requestId, code });
  expect(res.status).toBe(200);
  return (await res.json()) as Entered;
};
const otherCode = (code: string) => (code === '000000' ? '000001' : '000000');

/** Start a sign-in; return the tab's requestId and the emailed code. */
async function begin(app: App, sender: CapturingEmailSender, email = uniqueEmail()) {
  const res = await start(app, email);
  expect(res.status).toBe(200);
  const { requestId } = (await res.json()) as { requestId: string };
  return { email, requestId, code: codeOf(sender.sent.at(-1)!) };
}

afterEach(() => vi.useRealTimers());

describe('POST /v1/auth/email/start', () => {
  it('emails a 6-digit code in the subject and returns a requestId, not the code', async () => {
    const { app, sender } = buildApp();
    const email = uniqueEmail();
    const res = await start(app, email);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.requestId).toMatch(/^[\w-]{22}\.[\w-]{43}$/);
    expect(Object.keys(body).sort()).toEqual(['ok', 'requestId']);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.to).toBe(email);
    const code = codeOf(sender.sent[0]!);
    expect(sender.sent[0]?.body.text).toContain(code);
    expect(sender.sent[0]?.body.html).toContain(code);
    expect(JSON.stringify(body)).not.toContain(code);
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

describe('POST /v1/auth/email/verify', () => {
  it('the right code signs the tab in, and the token authenticates /v1/me', async () => {
    const { app, sender } = buildApp();
    const { email, requestId, code } = await begin(app, sender);
    const body = await enter(app, requestId, code);
    expect(body.status).toBe('signedIn');
    if (body.status !== 'signedIn') return;
    expect(body.user.email).toBe(email);
    expect(body.user.displayName).toBe(email.split('@')[0]);
    const me = await app.request('/v1/me', { headers: { authorization: `Bearer ${body.token}` } });
    expect(me.status).toBe(200);
  });

  it('a wrong code says how many tries are left; the right one still works', async () => {
    const { app, sender } = buildApp();
    const { requestId, code } = await begin(app, sender);
    expect(await enter(app, requestId, otherCode(code))).toEqual({
      status: 'wrong',
      attemptsLeft: 4,
    });
    expect((await enter(app, requestId, code)).status).toBe('signedIn');
  });

  it('five wrong codes use it up: even the right one is expired after', async () => {
    const { app, sender } = buildApp();
    const { requestId, code } = await begin(app, sender);
    for (let left = 4; left >= 1; left -= 1) {
      expect(await enter(app, requestId, otherCode(code))).toEqual({
        status: 'wrong',
        attemptsLeft: left,
      });
    }
    expect(await enter(app, requestId, otherCode(code))).toEqual({ status: 'expired' });
    expect(await enter(app, requestId, code)).toEqual({ status: 'expired' });
  });

  it('the right code entered twice (autofill and a tap) signs in both times', async () => {
    const { app, sender } = buildApp();
    const { requestId, code } = await begin(app, sender);
    const [a, b] = await Promise.all([enter(app, requestId, code), enter(app, requestId, code)]);
    expect(a.status).toBe('signedIn');
    expect(b.status).toBe('signedIn');
    // But not a wrong one once it's used.
    expect(await enter(app, requestId, otherCode(code))).toEqual({ status: 'expired' });
  });

  it('only for a few minutes after it was used', async () => {
    const { app, sender } = buildApp();
    const { requestId, code } = await begin(app, sender);
    expect((await enter(app, requestId, code)).status).toBe('signedIn');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);
    expect(await enter(app, requestId, code)).toEqual({ status: 'expired' });
  });

  it('expires after 15 minutes', async () => {
    const { app, sender } = buildApp();
    const { requestId, code } = await begin(app, sender);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1000);
    expect(await enter(app, requestId, code)).toEqual({ status: 'expired' });
  });

  it('only the tab that asked can enter it: a wrong or junk requestId is expired', async () => {
    const { app, sender } = buildApp();
    const { requestId, code } = await begin(app, sender);
    const [id] = requestId.split('.') as [string];
    expect(await enter(app, `${id}.${'A'.repeat(43)}`, code)).toEqual({ status: 'expired' });
    expect(await enter(app, 'nonsense', code)).toEqual({ status: 'expired' });
    // Spent no tries on the real request.
    expect((await enter(app, requestId, code)).status).toBe('signedIn');
  });

  it("another request's code doesn't work on this one", async () => {
    const { app, sender } = buildApp();
    const a = await begin(app, sender);
    const b = await begin(app, sender);
    if (a.code !== b.code) {
      expect((await enter(app, a.requestId, b.code)).status).toBe('wrong');
    }
  });

  it('400 for anything but 6 digits', async () => {
    const { app, sender } = buildApp();
    const { requestId } = await begin(app, sender);
    for (const code of ['12345', '1234567', 'abcdef', '']) {
      expect((await post(app, '/v1/auth/email/verify', { requestId, code })).status).toBe(400);
    }
    expect((await post(app, '/v1/auth/email/verify', { code: '123456' })).status).toBe(400);
  });

  it('the same email gets the same account each time', async () => {
    const { app, sender } = buildApp();
    const email = uniqueEmail();
    const first = await begin(app, sender, email);
    const a = await enter(app, first.requestId, first.code);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31_000);
    const second = await begin(app, sender, email);
    const b = await enter(app, second.requestId, second.code);
    expect(a.status === 'signedIn' && b.status === 'signedIn').toBe(true);
    if (a.status === 'signedIn' && b.status === 'signedIn') {
      expect(b.user.userId).toBe(a.user.userId);
    }
  });
});

describe('POST /v1/auth/email/start: sending limits (#76)', () => {
  it('one code every 30 seconds: a second ask is refused and the first code still works', async () => {
    const { app, sender } = buildApp();
    const { email, requestId, code } = await begin(app, sender);
    const again = await start(app, email);
    expect(again.status).toBe(429);
    const body = (await again.json()) as {
      error: { code: string; details: { retryAfterSeconds: number } };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.details.retryAfterSeconds).toBe(30);
    expect(sender.sent).toHaveLength(1);
    expect((await enter(app, requestId, code)).status).toBe('signedIn');
  });

  it('at most 5 codes in 15 minutes per address; other addresses are unaffected', async () => {
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
      /Too many codes/,
    );
    expect(sender.sent).toHaveLength(5);
    expect((await start(app, uniqueEmail())).status).toBe(200);
  });
});

describe('POST /v1/auth/email/start: limits across addresses (#146)', () => {
  it('+tags and Gmail dots share one address allowance', async () => {
    const { app } = buildApp();
    const name = `user${uuidv7().replace(/-/g, '')}`;
    expect((await start(app, `${name}+1@gmail.com`)).status).toBe(200);
    const dotted = `${name.slice(0, 4)}.${name.slice(4)}+2@googlemail.com`;
    expect((await start(app, dotted)).status).toBe(429);
  });

  it('at most 20 codes an hour from one IP address', async () => {
    const { app } = buildApp();
    const ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.7`;
    // Start of an hour, so the window doesn't roll over mid-test.
    const t0 = Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 1_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t0);
    for (let i = 0; i < 20; i += 1) {
      expect((await start(app, uniqueEmail(), {}, fromIp(ip))).status).toBe(200);
    }
    const refused = await start(app, uniqueEmail(), {}, fromIp(ip));
    expect(refused.status).toBe(429);
    const body = (await refused.json()) as {
      error: { code: string; message: string; details: { retryAfterSeconds: number } };
    };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.message).toMatch(/from here/);
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(3500);
    // Another IP, and no IP at all (local), are unaffected.
    expect((await start(app, uniqueEmail(), {}, fromIp('10.0.0.1'))).status).toBe(200);
    expect((await start(app, uniqueEmail())).status).toBe(200);
  });
});
