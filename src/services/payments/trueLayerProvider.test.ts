import { describe, it, expect } from 'vitest';
import { TrueLayerSandboxProvider } from './trueLayerProvider.js';

const cfg = {
  environment: 'sandbox' as const,
  clientId: 'test-client',
  clientSecret: 'test-secret',
  signingKid: 'test-kid',
  signingPrivateKeyPem: '-----BEGIN EC PRIVATE KEY-----\nfake\n-----END EC PRIVATE KEY-----',
  merchantAccountId: 'merch-1',
  returnUri: 'https://example.test/return',
};

describe('TrueLayerSandboxProvider — config', () => {
  it('rejects missing required config', () => {
    expect(() => new TrueLayerSandboxProvider({ ...cfg, clientId: '' })).toThrow(/clientId/);
    expect(() => new TrueLayerSandboxProvider({ ...cfg, clientSecret: '' })).toThrow(
      /clientSecret/,
    );
    expect(() => new TrueLayerSandboxProvider({ ...cfg, signingKid: '' })).toThrow(/signingKid/);
    expect(() => new TrueLayerSandboxProvider({ ...cfg, signingPrivateKeyPem: '' })).toThrow(
      /signingPrivateKeyPem/,
    );
    expect(() => new TrueLayerSandboxProvider({ ...cfg, merchantAccountId: '' })).toThrow(
      /merchantAccountId/,
    );
    expect(() => new TrueLayerSandboxProvider({ ...cfg, returnUri: '' })).toThrow(/returnUri/);
  });

  it('exposes name = truelayer', () => {
    expect(new TrueLayerSandboxProvider(cfg).name).toBe('truelayer');
  });
});

describe('TrueLayerSandboxProvider.parseWebhookEvent', () => {
  const provider = new TrueLayerSandboxProvider(cfg);

  it.each([
    ['payment_authorized', 'authorized'],
    ['payment_executed', 'executed'],
    ['payment_settled', 'settled'],
    ['payment_failed', 'failed'],
    ['payment_refunded', 'refunded'],
  ])('maps %s → %s', (tlType, ourType) => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({ type: tlType, payment_id: 'tl-pay-1', event_version: 1 }),
    );
    if (!event) throw new Error('expected event, got null');
    expect(event.type).toBe(ourType);
    expect(event.providerPaymentId).toBe('tl-pay-1');
  });

  it('passes failure_reason through to event.reason', () => {
    const event = provider.parseWebhookEvent(
      JSON.stringify({
        type: 'payment_failed',
        payment_id: 'tl-pay-2',
        failure_stage: 'authorisation',
        failure_reason: 'user_cancelled',
      }),
    );
    if (!event) throw new Error('expected event, got null');
    expect(event.reason).toBe('user_cancelled');
  });

  it('rejects invalid JSON', () => {
    expect(() => provider.parseWebhookEvent('not json')).toThrow(/JSON/);
  });

  it('returns null for explicitly-ignored event types (so TL stops retrying)', () => {
    const result = provider.parseWebhookEvent(
      JSON.stringify({ type: 'payment_creditable', payment_id: 'tl-pay-x' }),
    );
    expect(result).toBeNull();
  });

  it('returns null for unknown event types instead of throwing', () => {
    const result = provider.parseWebhookEvent(
      JSON.stringify({ type: 'payment_some_future_event', payment_id: 'x' }),
    );
    expect(result).toBeNull();
  });

  it('rejects missing payment_id', () => {
    expect(() =>
      provider.parseWebhookEvent(JSON.stringify({ type: 'payment_authorized' })),
    ).toThrow(/payment_id/);
  });

  it('rejects missing type field', () => {
    expect(() => provider.parseWebhookEvent(JSON.stringify({ payment_id: 'x' }))).toThrow();
  });
});

describe('TrueLayerSandboxProvider.verifyWebhookSignature', () => {
  const provider = new TrueLayerSandboxProvider(cfg);

  it('rejects when Tl-Signature header is missing', async () => {
    await expect(
      provider.verifyWebhookSignature({
        method: 'POST',
        path: '/webhooks/truelayer',
        headers: { 'content-type': 'application/json' },
        rawBody: '{}',
      }),
    ).rejects.toThrow(/Tl-Signature/);
  });
});
