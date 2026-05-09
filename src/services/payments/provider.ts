import type { WebhookEventType } from './stateMachine.js';

export interface InitiatePaymentInput {
  paymentId: string;
  amountPence: number;
  currency: 'GBP';
  payerUserId: string;
  collectorUserId: string;
  reference: string;
}

export interface InitiatedPayment {
  providerPaymentId: string;
  authorizationUrl: string;
}

export interface WebhookEvent {
  providerPaymentId: string;
  type: WebhookEventType;
  reason?: string;
}

export interface PaymentProvider {
  /** The wire identifier; must match Payment.provider in the response. */
  readonly name: 'truelayer';

  initiate(input: InitiatePaymentInput): Promise<InitiatedPayment>;

  /**
   * Verifies the webhook signature against the raw request body. Throws if
   * the signature is missing or invalid. The error message is logged but
   * not returned to the caller — webhook senders should not learn anything
   * about why their request was rejected.
   */
  verifyWebhookSignature(input: { rawBody: string; signature: string | undefined }): void;

  parseWebhookEvent(rawBody: string): WebhookEvent;
}
