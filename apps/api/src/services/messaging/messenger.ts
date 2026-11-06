import { baseLogger } from '../../logging/logger.js';
import { maskPhone, toWaId } from './phone.js';

/**
 * Sends WhatsApp messages (#230). `text` is free-form, allowed only inside
 * the 24-hour window the person opened by messaging us; `template` is a
 * Meta-approved template, allowed any time and paid per message.
 */
export interface Messenger {
  sendText(to: string, body: string): Promise<{ messageId: string }>;
  sendTemplate(to: string, template: TemplateMessage): Promise<{ messageId: string }>;
}

export interface TemplateMessage {
  name: string;
  /** Defaults to en_GB. */
  language?: string;
  /** The body's {{1}}, {{2}}, …, in order. */
  params?: string[];
}

export const GRAPH_VERSION = 'v23.0';

export class MessagingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** Meta's WhatsApp Cloud API, directly: no reseller fee on top. */
export class WhatsAppCloudMessenger implements Messenger {
  constructor(
    private readonly cfg: { phoneNumberId: string; accessToken: string },
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  sendText(to: string, body: string) {
    return this.post({ to: toWaId(to), type: 'text', text: { body, preview_url: false } });
  }

  sendTemplate(to: string, t: TemplateMessage) {
    return this.post({
      to: toWaId(to),
      type: 'template',
      template: {
        name: t.name,
        language: { code: t.language ?? 'en_GB' },
        ...(t.params?.length
          ? {
              components: [
                { type: 'body', parameters: t.params.map((text) => ({ type: 'text', text })) },
              ],
            }
          : {}),
      },
    });
  }

  private async post(message: Record<string, unknown>): Promise<{ messageId: string }> {
    const res = await this.fetchImpl(
      `https://graph.facebook.com/${GRAPH_VERSION}/${this.cfg.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.cfg.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          ...message,
        }),
      },
    );
    const json = (await res.json().catch(() => ({}))) as {
      messages?: Array<{ id?: string }>;
      error?: { message?: string; code?: number };
    };
    if (!res.ok || !json.messages?.[0]?.id) {
      // Meta's message, never the body we sent (it may hold a name or amount).
      throw new MessagingError(
        json.error?.message ?? `WhatsApp send failed (${res.status})`,
        res.status,
        json.error?.code,
      );
    }
    return { messageId: json.messages[0].id };
  }
}

/** Local and tests: logs that a message would go, keeps it for assertions. */
export class ConsoleMessenger implements Messenger {
  readonly outbox: Array<{
    to: string;
    kind: 'text' | 'template';
    body?: string;
    template?: TemplateMessage;
  }> = [];
  private n = 0;

  sendText(to: string, body: string) {
    this.outbox.push({ to, kind: 'text', body });
    baseLogger.info(
      { event: 'whatsapp.console', to: maskPhone(to), kind: 'text' },
      'WhatsApp (console)',
    );
    return Promise.resolve({ messageId: `console-${++this.n}` });
  }

  sendTemplate(to: string, template: TemplateMessage) {
    this.outbox.push({ to, kind: 'template', template });
    baseLogger.info(
      { event: 'whatsapp.console', to: maskPhone(to), kind: 'template', template: template.name },
      'WhatsApp (console)',
    );
    return Promise.resolve({ messageId: `console-${++this.n}` });
  }
}
