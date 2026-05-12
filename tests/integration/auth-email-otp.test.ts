import { describe, it, expect, beforeEach } from 'vitest';
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

function uniqueEmail(): string {
  return `user-${uuidv7()}@example.com`;
}

function extractCode(text: string): string {
  // The OTP service puts the code on its own line after "Your sign-in code:".
  const m = text.match(/(\d{6})/);
  if (!m) throw new Error(`No 6-digit code in email body: ${text}`);
  return m[1]!;
}

function buildApp() {
  const sender = new CapturingEmailSender();
  const app = createApp({
    emailSender: sender,
    sessionJwtSecret: SECRET,
    idTokenVerifier: createSessionTokenVerifier(SECRET),
    paymentProvider: null,
  });
  return { app, sender };
}

describe('POST /v1/auth/email/start', () => {
  it('emails a 6-digit code and returns { ok: true }', async () => {
    const { app, sender } = buildApp();
    const email = uniqueEmail();
    const res = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.to).toBe(email);
    expect(sender.sent[0]?.body.text).toMatch(/\d{6}/);
  });

  it('rejects malformed emails with 400 INVALID_INPUT', async () => {
    const { app } = buildApp();
    const res = await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not an email' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/auth/email/verify', () => {
  let app: ReturnType<typeof buildApp>['app'];
  let sender: CapturingEmailSender;
  let email: string;
  let code: string;

  beforeEach(async () => {
    ({ app, sender } = buildApp());
    email = uniqueEmail();
    await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    code = extractCode(sender.sent[0]!.body.text);
  });

  it('returns a token + user on the correct code', async () => {
    const res = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      user: { userId: string; email: string; displayName: string };
    };
    expect(typeof body.token).toBe('string');
    expect(body.token.split('.')).toHaveLength(3); // header.payload.signature
    expect(body.user.email).toBe(email);
    expect(body.user.userId).toMatch(/^[0-9a-f-]{36}$/);
    // displayName defaulted to the local-part of the email.
    expect(body.user.displayName).toBe(email.split('@')[0]);
  });

  it('the minted token authenticates a request to /v1/me', async () => {
    const verifyRes = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    const { token } = (await verifyRes.json()) as { token: string };

    const me = await app.request('/v1/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { email: string };
    expect(meBody.email).toBe(email);
  });

  it('rejects a wrong code as 401 AUTH_INVALID', async () => {
    const wrong = code === '000000' ? '111111' : '000000';
    const res = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: wrong }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('AUTH_INVALID');
  });

  it('cannot be reused — second verify with the same code fails', async () => {
    const ok = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    expect(ok.status).toBe(200);

    const again = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    expect(again.status).toBe(401);
  });

  it('subsequent sign-in returns the SAME userId for the same email', async () => {
    const r1 = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    const { user: u1 } = (await r1.json()) as { user: { userId: string } };

    // Start + verify a second time.
    await app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const code2 = extractCode(sender.sent[1]!.body.text);
    const r2 = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code: code2 }),
    });
    const { user: u2 } = (await r2.json()) as { user: { userId: string } };
    expect(u2.userId).toBe(u1.userId);
  });

  it('locks out after 5 wrong attempts', async () => {
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/auth/email/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, code: wrong }),
      });
      expect(res.status).toBe(401);
    }
    // 6th attempt — even with the CORRECT code — should fail because
    // the OTP row was invalidated at attempt 5.
    const sixth = await app.request('/v1/auth/email/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, code }),
    });
    expect(sixth.status).toBe(401);
  });
});
