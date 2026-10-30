import { describe, it, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { createSessionTokenVerifier } from '../../src/services/auth.js';
import type { EmailSender } from '../../src/services/email/sender.js';

const SECRET = new TextEncoder().encode('test-secret-must-be-at-least-16-bytes');
const noEmail: EmailSender = { provider: 'none', send: () => Promise.resolve() };

const buildApp = (devEmailSignIn: boolean) =>
  createApp({
    emailSender: noEmail,
    sessionJwtSecret: SECRET,
    idTokenVerifier: createSessionTokenVerifier(SECRET),
    paymentProvider: null,
    devEmailSignIn,
  });

const devSignIn = (app: ReturnType<typeof buildApp>, email: string) =>
  app.request('/v1/auth/email/dev-sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });

type SignIn = { token: string; user: { userId: string; email: string; displayName: string } };

describe('POST /v1/auth/email/dev-sign-in (local dev only)', () => {
  it('does not exist unless the local server enables it', async () => {
    const res = await devSignIn(buildApp(false), `a-${uuidv7()}@example.com`);
    expect(res.status).toBe(404);
  });

  it('a new email gets a new user and a working session token', async () => {
    const app = buildApp(true);
    const email = `new-${uuidv7()}@example.com`;
    const res = await devSignIn(app, email);
    expect(res.status).toBe(200);
    const body = (await res.json()) as SignIn;
    expect(body.user.email).toBe(email);

    const me = await app.request('/v1/me', { headers: { authorization: `Bearer ${body.token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { userId: string }).userId).toBe(body.user.userId);
  });

  it('a returning email (any case) gets the same user', async () => {
    const app = buildApp(true);
    const email = `back-${uuidv7()}@example.com`;
    const first = (await (await devSignIn(app, email)).json()) as SignIn;
    const again = (await (await devSignIn(app, email.toUpperCase())).json()) as SignIn;
    expect(again.user.userId).toBe(first.user.userId);
  });

  it('rejects malformed emails', async () => {
    const res = await devSignIn(buildApp(true), 'not-an-email');
    expect(res.status).toBe(400);
  });
});
