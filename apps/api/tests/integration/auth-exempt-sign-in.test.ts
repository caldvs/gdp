import { describe, it, expect, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { createSessionTokenVerifier } from '../../src/services/auth.js';
import type { EmailSender } from '../../src/services/email/sender.js';

const SECRET = new TextEncoder().encode('test-secret-must-be-at-least-16-bytes');

const setup = (exempt: string) => {
  const send = vi.fn<EmailSender['send']>(() => Promise.resolve());
  const app = createApp({
    emailSender: { provider: 'none', send },
    sessionJwtSecret: SECRET,
    idTokenVerifier: createSessionTokenVerifier(SECRET),
    exemptEmails: exempt,
  });
  const start = (email: string) =>
    app.request('/v1/auth/email/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
  return { app, send, start };
};

type Started = { ok: true; token?: string; user?: { userId: string; email: string } };

describe('POST /v1/auth/email/start for TABLE_FEE_EXEMPT_EMAILS', () => {
  it('an exempt address is signed in straight away, with no link emailed', async () => {
    const email = `owner-${uuidv7()}@example.com`;
    const { app, send, start } = setup(`someone@else.com, ${email.toUpperCase()}`);
    const res = await start(email);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Started;
    expect(body.ok).toBe(true);
    expect(body.user?.email).toBe(email);
    expect(send).not.toHaveBeenCalled();

    const me = await app.request('/v1/me', { headers: { authorization: `Bearer ${body.token}` } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { userId: string }).userId).toBe(body.user?.userId);
  });

  it('the same exempt address gets the same account each time', async () => {
    const email = `again-${uuidv7()}@example.com`;
    const { start } = setup(email);
    const a = (await (await start(email)).json()) as Started;
    const b = (await (await start(email.toUpperCase())).json()) as Started;
    expect(b.user?.userId).toBe(a.user?.userId);
  });

  it('everyone else gets a link, and no token', async () => {
    const { send, start } = setup('owner@example.com');
    const res = await start(`guest-${uuidv7()}@example.com`);
    const body = (await res.json()) as Started & { requestId?: string };
    expect(body.token).toBeUndefined();
    expect(body.requestId).toBeTruthy();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
