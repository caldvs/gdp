import { createHmac, timingSafeEqual } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import type {
  InitiatePaymentInput,
  InitiatedPayment,
  PaymentProvider,
  VerifyWebhookInput,
  WebhookEvent,
} from './provider.js';

const MockWebhookEventSchema = z.object({
  providerPaymentId: z.string().min(1),
  type: z.enum(['authorized', 'executed', 'settled', 'failed', 'refunded']),
  reason: z.string().optional(),
});

/**
 * In-process mock TrueLayer for tests and local dev. Signs webhooks with
 * HMAC-SHA256 against a shared secret. The interface matches what a real
 * TrueLayer integration would expose; only the verification scheme differs
 * (real TrueLayer uses detached JWS verified against their JWKS).
 */
export class MockTrueLayerProvider implements PaymentProvider {
  readonly name = 'truelayer' as const;

  constructor(private readonly webhookSecret: string) {
    if (!webhookSecret) {
      throw new Error('MockTrueLayerProvider requires a non-empty webhook secret');
    }
  }

  initiate(_input: InitiatePaymentInput): Promise<InitiatedPayment> {
    const providerPaymentId = `mock-${uuidv7()}`;
    return Promise.resolve({
      providerPaymentId,
      authorizationUrl: `https://mock-truelayer.local/authorize/${providerPaymentId}`,
    });
  }

  /**
   * Test-only: produce a signature for a body the way the mock provider
   * would sign it server-side. Tests use this to forge legitimate events.
   */
  signBody(rawBody: string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }

  verifyWebhookSignature(input: VerifyWebhookInput): void {
    const signature = input.headers['tl-signature'];
    if (!signature) {
      throw new AppError('AUTH_INVALID', 'Tl-Signature header missing');
    }
    const expected = this.signBody(input.rawBody);
    const expectedBuf = Buffer.from(expected, 'utf8');
    const actualBuf = Buffer.from(signature, 'utf8');
    if (expectedBuf.length !== actualBuf.length) {
      throw new AppError('AUTH_INVALID', 'Signature length mismatch');
    }
    if (!timingSafeEqual(expectedBuf, actualBuf)) {
      throw new AppError('AUTH_INVALID', 'Signature verification failed');
    }
  }

  parseWebhookEvent(rawBody: string): WebhookEvent {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new AppError('INVALID_INPUT', 'Webhook body is not valid JSON');
    }
    const result = MockWebhookEventSchema.safeParse(parsed);
    if (!result.success) {
      throw new AppError('INVALID_INPUT', 'Webhook payload schema invalid');
    }
    return result.data;
  }
}
