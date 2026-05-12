import { env } from '../../config/env.js';
import { baseLogger } from '../../logging/logger.js';
import { ConsoleEmailSender } from './consoleSender.js';
import { SesEmailSender } from './sesSender.js';
import type { EmailSender } from './sender.js';

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
    region: env.AWS_REGION,
    logger: baseLogger,
  });
};
