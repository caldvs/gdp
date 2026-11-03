import { env } from '../../config/env.js';
import { baseLogger } from '../../logging/logger.js';
import { ConsoleEmailSender } from './consoleSender.js';
import { SesEmailSender } from './sesSender.js';
import type { EmailSender } from './sender.js';

/** The sender name people see in their inbox (#113). */
export const EMAIL_FROM_NAME = 'Pay Me Back';

/**
 * Pick an EmailSender based on env. If SES_FROM_EMAIL is configured we
 * send for real via SES; otherwise we log to stdout via the console
 * sender. Local development just leaves SES_FROM_EMAIL unset and reads
 * OTPs / receipts from the dev server logs.
 */
export const createDefaultEmailSender = (): EmailSender => {
  if (!env.SES_FROM_EMAIL) {
    return new ConsoleEmailSender(baseLogger);
  }
  return new SesEmailSender({
    fromAddress: env.SES_FROM_EMAIL,
    fromName: EMAIL_FROM_NAME,
    region: env.AWS_REGION,
    logger: baseLogger,
  });
};
