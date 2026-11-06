import { Hono } from 'hono';
import { AppError } from '../errors/AppError.js';
import { whatsappStore } from '../storage/whatsappStore.js';
import {
  inboundMessages,
  signatureValid,
  type InboundMessage,
} from '../services/messaging/webhook.js';
import { maskPhone } from '../services/messaging/phone.js';

export interface WhatsAppWebhookDeps {
  appSecret: string;
  verifyToken: string;
  /** What to do with each new message (sign-in codes, #213). Default: nothing. */
  onInbound?: (msg: InboundMessage) => Promise<void>;
}

/**
 * #230: Meta's WhatsApp webhook. `GET` is the subscribe handshake; `POST`
 * carries messages. Each message opens that number's free 24-hour reply
 * window. Bodies and whole numbers are never logged.
 */
export const buildWhatsAppWebhookRoutes = (deps: WhatsAppWebhookDeps): Hono => {
  const r = new Hono();

  r.get('/whatsapp', (c) => {
    const mode = c.req.query('hub.mode');
    const token = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge') ?? '';
    if (mode !== 'subscribe' || token !== deps.verifyToken) {
      throw new AppError('AUTH_INVALID', 'Verify token rejected');
    }
    return c.text(challenge);
  });

  r.post('/whatsapp', async (c) => {
    const raw = await c.req.text();
    const log = c.var.logger;
    if (!signatureValid(raw, c.req.header('x-hub-signature-256'), deps.appSecret)) {
      log?.warn({ bytes: raw.length }, 'whatsapp webhook signature rejected');
      throw new AppError('AUTH_INVALID', 'Webhook signature rejected');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new AppError('INVALID_INPUT', 'Not JSON');
    }
    let handled = 0;
    for (const msg of inboundMessages(payload)) {
      // Meta retries until it gets a 200: handle each message once.
      if (!(await whatsappStore.firstSight(msg.messageId))) continue;
      await whatsappStore.openWindow(msg.from, msg.at);
      await deps.onInbound?.(msg);
      handled += 1;
      log?.info(
        { event: 'whatsapp.inbound', from: maskPhone(msg.from), type: msg.type },
        'whatsapp message',
      );
    }
    return c.json({ ok: true, handled });
  });

  return r;
};
