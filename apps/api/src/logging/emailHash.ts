import { createHash } from 'node:crypto';

/**
 * A short, stable stand-in for an email address in logs (#155): enough to
 * tie log lines about one address together, without keeping the address
 * itself for the logs' 180 days.
 */
export const emailHash = (email: string): string =>
  createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 12);
