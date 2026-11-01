import { describe, it, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { createSessionTokenVerifier } from '../../src/services/auth.js';
import type { EmailSender } from '../../src/services/email/sender.js';

const SECRET = new TextEncoder().encode('test-secret-must-be-at-least-16-bytes');
const noEmail: EmailSender = { provider: 'none', send: () => Promise.resolve() };

const buildApp = (testAccountSignIn: boolean) =>
  createApp({
    emailSender: noEmail,
    sessionJwtSecret: SECRET,
    idTokenVerifier: createSessionTokenVerifier(SECRET),
    paymentProvider: null,
    testAccountSignIn,
  });

const testSignIn = (app: ReturnType<typeof buildApp>, email: string) =>
  app.request('/v1/auth/email/test-sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });

type SignIn = { token: string; user: { userId: string; email: string; displayName: string } };

describe('POST /v1/auth/email/test-sign-in (local and dev only)', () => {
  it('does not exist unless enabled', async () => {
    const res = await testSignIn(buildApp(false), `a-${uuidv7()}@test.invalid`);
    expect(res.status).toBe(404);
  });

  it('signs a test account in without a code, the same user each time', async () => {
    const app = buildApp(true);
    const email = `guest-${uuidv7()}@test.invalid`;
    const first = await testSignIn(app, email);
    expect(first.status).toBe(200);
    const body = (await first.json()) as SignIn;
    expect(body.user.email).toBe(email);

    const me = await app.request('/v1/me', { headers: { authorization: `Bearer ${body.token}` } });
    expect(me.status).toBe(200);

    const again = (await (await testSignIn(app, email.toUpperCase())).json()) as SignIn;
    expect(again.user.userId).toBe(body.user.userId);
  });

  it('refuses real addresses, so nobody can sign in as a real person', async () => {
    const res = await testSignIn(buildApp(true), `real-${uuidv7()}@gmail.com`);
    expect(res.status).toBe(400);
  });
});
