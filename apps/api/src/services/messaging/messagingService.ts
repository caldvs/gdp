import { baseLogger } from '../../logging/logger.js';
import { whatsappStore } from '../../storage/whatsappStore.js';
import {
  ConsoleMessenger,
  WhatsAppCloudMessenger,
  type Messenger,
  type TemplateMessage,
} from './messenger.js';
import { maskPhone } from './phone.js';

/** Paid template sends a month before we stop and alarm (about £10–15 at UK rates). */
export const DEFAULT_TEMPLATE_CAP = 500;

export type SendOutcome =
  | { sent: true; via: 'text' | 'template'; messageId: string }
  | { sent: false; reason: 'window-closed' | 'monthly-cap' };

/**
 * #230: send someone a WhatsApp message as cheaply as allowed. Inside the
 * 24-hour window they opened by messaging us: the free-form `text`, free.
 * Outside it: the `template`, if there is one, counted against the
 * monthly cap; otherwise nothing is sent.
 */
export function messagingService(deps: { messenger: Messenger; templateCap?: number }) {
  const cap = deps.templateCap ?? DEFAULT_TEMPLATE_CAP;
  return {
    async send(input: {
      to: string;
      text: string;
      template?: TemplateMessage;
    }): Promise<SendOutcome> {
      if (await whatsappStore.windowOpen(input.to)) {
        const { messageId } = await deps.messenger.sendText(input.to, input.text);
        return { sent: true, via: 'text', messageId };
      }
      if (!input.template) return { sent: false, reason: 'window-closed' };
      if (!(await whatsappStore.countTemplate(cap))) {
        baseLogger.error(
          {
            event: 'whatsapp.template_cap',
            to: maskPhone(input.to),
            template: input.template.name,
            cap,
          },
          'WhatsApp monthly template cap reached',
        );
        return { sent: false, reason: 'monthly-cap' };
      }
      const { messageId } = await deps.messenger.sendTemplate(input.to, input.template);
      return { sent: true, via: 'template', messageId };
    },
  };
}
export type MessagingService = ReturnType<typeof messagingService>;

/** The real Cloud API when the Meta app is set up (#229); the console otherwise. */
export function messengerFromEnv(e: {
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
}): Messenger {
  return e.WHATSAPP_PHONE_NUMBER_ID && e.WHATSAPP_ACCESS_TOKEN
    ? new WhatsAppCloudMessenger({
        phoneNumberId: e.WHATSAPP_PHONE_NUMBER_ID,
        accessToken: e.WHATSAPP_ACCESS_TOKEN,
      })
    : new ConsoleMessenger();
}
