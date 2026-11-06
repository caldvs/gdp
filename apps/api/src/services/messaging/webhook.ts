import { createHmac, timingSafeEqual } from 'node:crypto';
import { toE164 } from './phone.js';

/** One message someone sent our WhatsApp number. */
export interface InboundMessage {
  messageId: string;
  /** E.164, e.g. `+447700900123`. WhatsApp has already verified it's theirs. */
  from: string;
  /** Their WhatsApp profile name, if shared. */
  profileName?: string;
  at: Date;
  type: string;
  /** For text messages. */
  text?: string;
}

/** Meta signs the raw body with the app secret: `X-Hub-Signature-256: sha256=<hex>`. */
export function signatureValid(
  rawBody: string,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const given = Buffer.from(header.slice(7), 'hex');
  const want = createHmac('sha256', appSecret).update(rawBody, 'utf8').digest();
  return given.length === want.length && timingSafeEqual(given, want);
}

type Payload = {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
};

/** The messages in a webhook payload. Status updates (sent, delivered, read) are skipped. */
export function inboundMessages(payload: unknown): InboundMessage[] {
  const p = payload as Payload;
  if (p?.object !== 'whatsapp_business_account') return [];
  const out: InboundMessage[] = [];
  for (const entry of p.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'messages') continue;
      const names = new Map((change.value?.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of change.value?.messages ?? []) {
        if (!m.id || !m.from) continue;
        const seconds = Number(m.timestamp);
        const profileName = names.get(m.from);
        out.push({
          messageId: m.id,
          from: toE164(m.from),
          ...(profileName ? { profileName } : {}),
          at: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : new Date(),
          type: m.type ?? 'unknown',
          ...(m.type === 'text' && typeof m.text?.body === 'string' ? { text: m.text.body } : {}),
        });
      }
    }
  }
  return out;
}
