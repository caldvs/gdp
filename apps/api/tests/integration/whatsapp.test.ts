/**
 * #230: Meta's WhatsApp webhook and sending. A message from someone opens
 * their free 24-hour window: replies go as free-form text. Outside it only
 * a template goes, counted against the monthly cap.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { ConsoleMessenger } from '../../src/services/messaging/messenger.js';
import { messagingService } from '../../src/services/messaging/messagingService.js';
import { whatsappStore } from '../../src/storage/whatsappStore.js';
import type { InboundMessage } from '../../src/services/messaging/webhook.js';
import { fakeVerifier, sampleParsedBill } from './helpers.js';

const SECRET = 'app-secret';
const onInbound = vi.fn((_m: InboundMessage) => Promise.resolve());
const app = createApp({
  idTokenVerifier: fakeVerifier,
  billParser: new FixtureBillParser(sampleParsedBill),
  whatsapp: { appSecret: SECRET, verifyToken: 'verify-me', onInbound },
});

const phone = () => `+4477${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const post = (body: unknown, sig?: string) => {
  const raw = JSON.stringify(body);
  return app.request('/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256':
        sig ?? `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`,
    },
    body: raw,
  });
};
const message = (from: string, id = `wamid.${uuidv7()}`, text = 'hello') => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          field: 'messages',
          value: {
            contacts: [{ wa_id: from.slice(1), profile: { name: 'Sam' } }],
            messages: [
              {
                id,
                from: from.slice(1),
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: 'text',
                text: { body: text },
              },
            ],
          },
        },
      ],
    },
  ],
});

describe('WhatsApp webhook (#230)', () => {
  it('answers Meta’s subscribe handshake only with the verify token', async () => {
    const ok = await app.request(
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42',
    );
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('42');
    const bad = await app.request(
      '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42',
    );
    expect(bad.status).toBe(401);
  });

  it('refuses an unsigned or wrongly signed body', async () => {
    expect((await post(message(phone()), 'sha256=00')).status).toBe(401);
  });

  it('a message opens the sender’s window, once, even when Meta retries', async () => {
    onInbound.mockClear();
    const from = phone();
    expect(await whatsappStore.windowOpen(from)).toBe(false);
    const body = message(from, `wamid.${uuidv7()}`, 'Sign in 4821');
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, handled: 1 });
    expect(await (await post(body)).json()).toEqual({ ok: true, handled: 0 });
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound.mock.calls[0]![0]).toMatchObject({
      from,
      text: 'Sign in 4821',
      profileName: 'Sam',
    });
    expect(await whatsappStore.windowOpen(from)).toBe(true);
    // 24 hours later it's shut.
    expect(await whatsappStore.windowOpen(from, new Date(Date.now() + 24 * 3600_000))).toBe(false);
  });

  it('without its secrets the webhook isn’t there', async () => {
    const off = createApp({ idTokenVerifier: fakeVerifier, whatsapp: null });
    expect((await off.request('/webhooks/whatsapp?hub.mode=subscribe')).status).toBe(404);
  });
});

describe('sending (#230)', () => {
  it('inside the window: free-form text; outside: the template, or nothing', async () => {
    const messenger = new ConsoleMessenger();
    const svc = messagingService({ messenger, templateCap: 10_000 });
    const inWindow = phone();
    await whatsappStore.openWindow(inWindow, new Date());
    expect(
      await svc.send({ to: inWindow, text: 'Callum got your £17.25', template: { name: 'paid' } }),
    ).toMatchObject({
      sent: true,
      via: 'text',
    });
    const cold = phone();
    expect(await svc.send({ to: cold, text: 'hi' })).toEqual({
      sent: false,
      reason: 'window-closed',
    });
    expect(
      await svc.send({ to: cold, text: 'hi', template: { name: 'reminder', params: ['Callum'] } }),
    ).toMatchObject({
      sent: true,
      via: 'template',
    });
    expect(messenger.outbox.map((o) => o.kind)).toEqual(['text', 'template']);
  });

  it('stops at the monthly template cap', async () => {
    const messenger = new ConsoleMessenger();
    // The month's count is shared: a cap of 0 is always reached.
    const svc = messagingService({ messenger, templateCap: 0 });
    expect(await svc.send({ to: phone(), text: 'x', template: { name: 'reminder' } })).toEqual({
      sent: false,
      reason: 'monthly-cap',
    });
    expect(messenger.outbox).toEqual([]);
  });
});
