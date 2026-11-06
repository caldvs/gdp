import {
  PinpointSMSVoiceV2Client,
  SendTextMessageCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { baseLogger } from '../../logging/logger.js';
import { maskPhone } from './phone.js';

/**
 * #231: texts, through AWS End User Messaging SMS in the API's own account
 * and region. No company registration or template review: the message is
 * ours, from an alphanumeric sender ID (`PayMeBack`, one-way). Every text
 * is paid, so callers rate-limit hard.
 */
export interface SmsSender {
  send(to: string, body: string): Promise<{ messageId: string }>;
}

export class AwsSmsSender implements SmsSender {
  constructor(
    private readonly cfg: { senderId: string; configurationSet?: string },
    private readonly client = new PinpointSMSVoiceV2Client({}),
  ) {}

  async send(to: string, body: string) {
    const out = await this.client.send(
      new SendTextMessageCommand({
        DestinationPhoneNumber: to,
        OriginationIdentity: this.cfg.senderId,
        MessageBody: body,
        MessageType: 'TRANSACTIONAL',
        ...(this.cfg.configurationSet ? { ConfigurationSetName: this.cfg.configurationSet } : {}),
      }),
    );
    return { messageId: out.MessageId ?? '' };
  }
}

/** Local and tests: keeps texts for assertions; locally prints a code to type. */
export class ConsoleSmsSender implements SmsSender {
  readonly outbox: { to: string; body: string }[] = [];
  private n = 0;

  constructor(private readonly opts: { printCodes?: boolean } = {}) {}

  send(to: string, body: string) {
    this.outbox.push({ to, body });
    baseLogger.info({ event: 'sms.console', to: maskPhone(to) }, 'SMS (console)');
    if (this.opts.printCodes) {
      // eslint-disable-next-line no-console
      console.log(`📱 Text for ${maskPhone(to)}: ${body.split('\n')[0]}`);
    }
    return Promise.resolve({ messageId: `sms-console-${++this.n}` });
  }
}
