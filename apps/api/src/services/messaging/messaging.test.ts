import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { inboundMessages, signatureValid } from './webhook.js';
import { ConsoleMessenger, MessagingError, WhatsAppCloudMessenger } from './messenger.js';
import { maskPhone, toE164, toWaId } from './phone.js';
import { messengerFromEnv } from './messagingService.js';

const sign = (body: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const payload = (messages: unknown[], contacts: unknown[] = []) => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: { contacts, messages } }] }],
});

describe('phone numbers', () => {
  it('converts between WhatsApp ids and E.164, and masks for logs', () => {
    expect(toE164('447700900123')).toBe('+447700900123');
    expect(toWaId('+44 7700 900123')).toBe('447700900123');
    expect(maskPhone('+447700900123')).toBe('+44•••••••123');
    expect(maskPhone('123')).toBe('•••');
  });
});

describe('webhook signature (X-Hub-Signature-256)', () => {
  const body = '{"a":1}';
  it('accepts the app secret’s HMAC of the raw body', () => {
    expect(signatureValid(body, sign(body, 'shh'), 'shh')).toBe(true);
  });
  it('rejects another secret, another body, a missing or malformed header', () => {
    expect(signatureValid(body, sign(body, 'other'), 'shh')).toBe(false);
    expect(signatureValid('{"a":2}', sign(body, 'shh'), 'shh')).toBe(false);
    expect(signatureValid(body, undefined, 'shh')).toBe(false);
    expect(signatureValid(body, 'sha1=abc', 'shh')).toBe(false);
    expect(signatureValid(body, 'sha256=zz', 'shh')).toBe(false);
  });
});

describe('inbound messages', () => {
  it('reads text messages with the sender, profile name and time', () => {
    const msgs = inboundMessages(
      payload(
        [
          {
            id: 'wamid.1',
            from: '447700900123',
            timestamp: '1794000000',
            type: 'text',
            text: { body: 'Sign in 4821' },
          },
        ],
        [{ wa_id: '447700900123', profile: { name: 'Sam' } }],
      ),
    );
    expect(msgs).toEqual([
      {
        messageId: 'wamid.1',
        from: '+447700900123',
        profileName: 'Sam',
        at: new Date(1794000000 * 1000),
        type: 'text',
        text: 'Sign in 4821',
      },
    ]);
  });

  it('keeps non-text messages without a body, and skips status updates and other objects', () => {
    expect(
      inboundMessages(payload([{ id: 'wamid.2', from: '44770', type: 'image' }]))[0],
    ).toMatchObject({
      type: 'image',
    });
    expect(
      inboundMessages(payload([{ id: 'wamid.2', from: '44770', type: 'image' }]))[0],
    ).not.toHaveProperty('text');
    expect(
      inboundMessages({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'x' }] } }] }],
      }),
    ).toEqual([]);
    expect(inboundMessages({ object: 'page', entry: [] })).toEqual([]);
    expect(inboundMessages(null)).toEqual([]);
    expect(inboundMessages(payload([{ from: '44770' }]))).toEqual([]);
  });
});

describe('WhatsApp Cloud API messenger', () => {
  const ok = () =>
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: 200 }),
      ),
    );

  it('sends free-form text to the Graph API with the token', async () => {
    const f = ok();
    const m = new WhatsAppCloudMessenger({ phoneNumberId: '123', accessToken: 'tok' }, f);
    expect(await m.sendText('+447700900123', 'Callum got your £17.25')).toEqual({
      messageId: 'wamid.out',
    });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v23.0/123/messages');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toMatchObject({
      messaging_product: 'whatsapp',
      to: '447700900123',
      type: 'text',
      text: { body: 'Callum got your £17.25', preview_url: false },
    });
  });

  it('sends a template with its body parameters, en_GB by default', async () => {
    const f = ok();
    const m = new WhatsAppCloudMessenger({ phoneNumberId: '123', accessToken: 'tok' }, f);
    await m.sendTemplate('+447700900123', { name: 'reminder', params: ['Callum', '£17.25'] });
    await m.sendTemplate('+447700900123', { name: 'bare', language: 'en_US' });
    const bodies = f.mock.calls.map(
      (c) =>
        JSON.parse((c as unknown as [string, RequestInit])[1].body as string) as {
          template: unknown;
        },
    );
    expect(bodies[0]!.template).toEqual({
      name: 'reminder',
      language: { code: 'en_GB' },
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: 'Callum' },
            { type: 'text', text: '£17.25' },
          ],
        },
      ],
    });
    expect(bodies[1]!.template).toEqual({ name: 'bare', language: { code: 'en_US' } });
  });

  it('throws Meta’s error, not what was sent', async () => {
    const f = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: { message: 'Re-engagement message', code: 131047 } }),
          { status: 400 },
        ),
      ),
    );
    const m = new WhatsAppCloudMessenger({ phoneNumberId: '123', accessToken: 'tok' }, f);
    const err = (await m
      .sendText('+44770', 'secret amount')
      .catch((e: unknown) => e)) as MessagingError;
    expect(err).toBeInstanceOf(MessagingError);
    expect(err).toMatchObject({ message: 'Re-engagement message', status: 400, code: 131047 });
    expect(err.message).not.toContain('secret amount');

    const bad = vi.fn(() => Promise.resolve(new Response('nope', { status: 502 })));
    await expect(
      new WhatsAppCloudMessenger({ phoneNumberId: '1', accessToken: 't' }, bad).sendText(
        '+44770',
        'x',
      ),
    ).rejects.toMatchObject({ message: 'WhatsApp send failed (502)', status: 502 });
  });

  it('the console messenger keeps an outbox instead', async () => {
    const m = new ConsoleMessenger();
    await m.sendText('+44770', 'hi');
    await m.sendTemplate('+44770', { name: 'reminder' });
    expect(m.outbox.map((o) => o.kind)).toEqual(['text', 'template']);
  });

  it('uses the Cloud API only when the Meta app is configured', () => {
    expect(messengerFromEnv({})).toBeInstanceOf(ConsoleMessenger);
    expect(messengerFromEnv({ WHATSAPP_PHONE_NUMBER_ID: '1' })).toBeInstanceOf(ConsoleMessenger);
    expect(
      messengerFromEnv({ WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_ACCESS_TOKEN: 't' }),
    ).toBeInstanceOf(WhatsAppCloudMessenger);
  });
});

describe('#213 phone numbers and the copy-code button', () => {
  it('parses UK mobiles as typed', async () => {
    const { parseUkMobile, formatUkMobile } = await import('./phone.js');
    for (const t of [
      '07700 900123',
      '7700900123',
      '+44 7700 900123',
      '0044 7700-900123',
      '(07700) 900 123',
    ]) {
      expect(parseUkMobile(t)).toBe('+447700900123');
    }
    for (const t of ['020 7946 0000', '0770090012', '+1 555 165 1251', 'abc', '']) {
      expect(parseUkMobile(t)).toBeNull();
    }
    expect(formatUkMobile('+447700900123')).toBe('+44 7700 900123');
  });

  it('sends the code as the button parameter too', async () => {
    const f = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.1' }] }), { status: 200 }),
      ),
    );
    const m = new WhatsAppCloudMessenger({ phoneNumberId: '1', accessToken: 't' }, f);
    await m.sendTemplate('+447700900123', {
      name: 'pmb_sign_in_code',
      params: ['4829'],
      copyCode: '4829',
    });
    const body = JSON.parse(
      (f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as {
      template: { components: unknown[] };
    };
    expect(body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '4829' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '4829' }] },
    ]);
  });
});
