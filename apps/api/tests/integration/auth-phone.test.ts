/**
 * #213, #231: sign in with your phone. The code goes through a
 * ConsoleSmsSender here, kept in its outbox, so no real text is sent.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createSessionTokenVerifier } from '../../src/services/auth.js';
import { ConsoleSmsSender } from '../../src/services/messaging/sms.js';

const SECRET = new TextEncoder().encode('test-secret-must-be-at-least-16-bytes');

/** A fresh UK mobile per test, so the per-number limits don't collide. */
const mobile = () => `07700 ${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`;
const e164 = (typed: string) => `+44${typed.replace(/\D/g, '').slice(1)}`;

function build(sms: ConsoleSmsSender | null = new ConsoleSmsSender()) {
  const app = createApp({
    sessionJwtSecret: SECRET,
    idTokenVerifier: createSessionTokenVerifier(SECRET),
    phoneSms: sms,
  });
  return { app, sms };
}
type App = ReturnType<typeof build>['app'];

const call = (app: App, method: string, path: string, body?: unknown, token?: string) =>
  app.request(path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type Started = { ok: true; requestId: string; phone: string };
type Entered = {
  status: 'signedIn' | 'wrong' | 'expired';
  token?: string;
  isNew?: boolean;
  attemptsLeft?: number;
  user?: { userId: string; email: string; displayName: string };
};

async function start(app: App, phone: string) {
  const res = await call(app, 'POST', '/v1/auth/phone/start', { phone });
  expect(res.status).toBe(200);
  return (await res.json()) as Started;
}
const verify = async (app: App, requestId: string, code: string) =>
  (await (await call(app, 'POST', '/v1/auth/phone/verify', { requestId, code })).json()) as Entered;

const TEXT = /^(\d{4}) is your Pay Me Back code\. Don’t share this code\.\n\n@paymeback\.dev #\1$/;
const lastCode = (s: ConsoleSmsSender) => TEXT.exec(s.outbox.at(-1)!.body)![1]!;

describe('phone sign-in (#213, #231)', () => {
  it('methods say what is on', async () => {
    const on = await (await build().app.request('/v1/auth/methods')).json();
    expect(on).toEqual({ email: true, phone: true, sms: true });
    const off = await (await build(null).app.request('/v1/auth/methods')).json();
    expect(off).toEqual({ email: true, phone: false, sms: false });
  });

  it('texts a 4-digit code in our words, signs in, makes the account once', async () => {
    const { app, sms } = build();
    const typed = mobile();
    const s = await start(app, typed);
    expect(s.phone).toBe(e164(typed));
    expect(sms!.outbox).toHaveLength(1);
    expect(sms!.outbox[0]!.to).toBe(e164(typed));
    expect(sms!.outbox[0]!.body).toMatch(TEXT);
    const code = lastCode(sms!);

    const first = await verify(app, s.requestId, code);
    expect(first).toMatchObject({
      status: 'signedIn',
      isNew: true,
      user: { email: '', displayName: '' },
    });
    const before = (await (
      await call(app, 'GET', '/v1/me', undefined, first.token)
    ).json()) as Record<string, unknown>;
    expect(before.needsName).toBe(true);

    // Name and bill email, then a fresh token that carries the name.
    const patched = await call(
      app,
      'PATCH',
      '/v1/me',
      { displayName: 'Callum', email: 'c@example.com' },
      first.token,
    );
    expect(patched.status).toBe(200);
    const { token } = (await patched.json()) as { token: string };
    const me = (await (await call(app, 'GET', '/v1/me', undefined, token)).json()) as Record<
      string,
      unknown
    >;
    expect(me).toMatchObject({
      userId: first.user!.userId,
      displayName: 'Callum',
      email: 'c@example.com',
    });
    expect(me.needsName).toBeUndefined();

    // The same number again within 30 s: refused, nothing sent.
    const { app: app2, sms: s2 } = build();
    const again = await call(app2, 'POST', '/v1/auth/phone/start', { phone: e164(typed) });
    expect(again.status).toBe(429);
    expect(s2!.outbox).toHaveLength(0);
  });

  it('a known number signs into the same account, named', async () => {
    const { app, sms } = build();
    const a = await start(app, mobile());
    const first = await verify(app, a.requestId, lastCode(sms!));
    await call(app, 'PATCH', '/v1/me', { displayName: 'Sam' }, first.token);
    // The same request again within its recheck window.
    const again = await verify(app, a.requestId, lastCode(sms!));
    expect(again).toMatchObject({
      status: 'signedIn',
      isNew: false,
      user: { userId: first.user!.userId, displayName: 'Sam' },
    });
  });

  it('older pages that still send channel: sms work', async () => {
    const { app, sms } = build();
    const res = await call(app, 'POST', '/v1/auth/phone/start', {
      phone: mobile(),
      channel: 'sms',
    });
    expect(res.status).toBe(200);
    expect(sms!.outbox).toHaveLength(1);
  });

  it('wrong codes count down, then the code is gone', async () => {
    const { app, sms } = build();
    const s = await start(app, mobile());
    const right = lastCode(sms!);
    const wrong = right === '0000' ? '1111' : '0000';
    expect(await verify(app, s.requestId, wrong)).toEqual({ status: 'wrong', attemptsLeft: 4 });
    for (let i = 0; i < 4; i++) await verify(app, s.requestId, wrong);
    expect(await verify(app, s.requestId, right)).toEqual({ status: 'expired' });
    expect(await verify(app, 'not-a-request', right)).toEqual({ status: 'expired' });
  });

  it('refuses a non-UK-mobile, a WhatsApp channel, and when texts are off', async () => {
    const { app } = build();
    expect(
      (await call(app, 'POST', '/v1/auth/phone/start', { phone: '020 7946 0000' })).status,
    ).toBe(400);
    expect(
      (await call(app, 'POST', '/v1/auth/phone/start', { phone: mobile(), channel: 'whatsapp' }))
        .status,
    ).toBe(400);
    expect(
      (await call(build(null).app, 'POST', '/v1/auth/phone/start', { phone: mobile() })).status,
    ).toBe(503);
  });

  it('PATCH /v1/me checks its input and refuses guests', async () => {
    const { app, sms } = build();
    const s = await start(app, mobile());
    const { token } = await verify(app, s.requestId, lastCode(sms!));
    expect((await call(app, 'PATCH', '/v1/me', { email: 'nope' }, token)).status).toBe(400);
    expect((await call(app, 'PATCH', '/v1/me', { phone: '+44' }, token)).status).toBe(400);
    expect((await call(app, 'PATCH', '/v1/me', { displayName: 'X' })).status).toBe(401);
  });
});
