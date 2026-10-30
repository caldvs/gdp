import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type { EmailSender, SendEmailInput } from './sender.js';
import type { Logger } from '../../logging/logger.js';
import { timed } from '../../logging/timed.js';

export interface SesEmailSenderConfig {
  fromAddress: string;
  region?: string;
  /**
   * Inject for tests. In production the constructor builds its own
   * client from the AWS SDK default chain.
   */
  client?: SESv2Client;
  logger?: Logger;
}

export class SesEmailSender implements EmailSender {
  readonly provider = 'ses';
  private readonly client: SESv2Client;

  constructor(private readonly config: SesEmailSenderConfig) {
    this.client = config.client ?? new SESv2Client({ region: config.region });
  }

  async send(input: SendEmailInput): Promise<void> {
    const cmd = new SendEmailCommand({
      FromEmailAddress: this.config.fromAddress,
      Destination: { ToAddresses: [input.to] },
      Content: {
        Simple: {
          Subject: { Data: input.subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: input.body.text, Charset: 'UTF-8' },
            Html: { Data: input.body.html, Charset: 'UTF-8' },
          },
        },
      },
      ...(input.category ? { EmailTags: [{ Name: 'category', Value: input.category }] } : {}),
    });

    try {
      const out = await timed('ses', 'sendEmail', () => this.client.send(cmd), {
        category: input.category,
      });
      this.config.logger?.info(
        {
          event: 'email.sent',
          provider: this.provider,
          to: input.to,
          category: input.category,
          messageId: out.MessageId,
        },
        'email sent',
      );
    } catch (err) {
      this.config.logger?.error(
        { event: 'email.send_failed', provider: this.provider, to: input.to, err },
        'email send failed',
      );
      throw err;
    }
  }
}
