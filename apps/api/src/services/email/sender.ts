/**
 * Transactional email abstraction. The rest of the codebase depends on
 * this interface, never on a specific provider. Swap to Resend, Postmark,
 * SMTP, etc. by adding a new implementation and updating the factory.
 */
export interface EmailSender {
  /** Provider identifier — useful for logs / metrics. */
  readonly provider: string;

  send(input: SendEmailInput): Promise<void>;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  /**
   * Both formats are required. Plain text protects against clients that
   * can't / won't render HTML (or that flag HTML-only mail as spam).
   */
  body: { text: string; html: string };
  /**
   * Tag for SES (and any provider) to bucket deliverability metrics on.
   * E.g. "otp", "receipt". Optional.
   */
  category?: string;
}
