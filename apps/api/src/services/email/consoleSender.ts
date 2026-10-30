import type { EmailSender, SendEmailInput } from './sender.js';
import type { Logger } from '../../logging/logger.js';

/**
 * No-op sender for local development. Logs the email content so you can
 * read the OTP / receipt / etc. straight out of the dev server logs without
 * needing SES configured. Never wire this into a deployed environment —
 * actually-not-sending-the-email-but-pretending-to is a footgun in prod.
 */
export class ConsoleEmailSender implements EmailSender {
  readonly provider = 'console';

  constructor(private readonly logger?: Logger) {}

  send(input: SendEmailInput): Promise<void> {
    this.logger?.info(
      {
        event: 'email.console',
        to: input.to,
        subject: input.subject,
        category: input.category,
        body: input.body.text,
      },
      'console email (not delivered — set SES_FROM_EMAIL to send for real)',
    );
    return Promise.resolve();
  }
}
