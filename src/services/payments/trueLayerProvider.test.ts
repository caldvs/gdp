import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { TrueLayerSandboxProvider } from './trueLayerProvider.js';

const cfg = {
  environment: 'sandbox' as const,
  clientId: 'test-client',
  clientSecret: 'test-secret',
  signingKid: 'test-kid',
  signingPrivateKeyPem: '-----BEGIN EC PRIVATE KEY-----\nfake\n-----END EC PRIVATE KEY-----',
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

describe('TrueLayerSandboxProvider.initiate', () => {
  // truelayer-signing requires a real EC P-521 PEM. Generate one per suite
  // — cheap, and keeps the signing path real (we're testing OUR payload, not
  // mocking out signature production entirely).
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp521r1' });
  const realPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

  const liveCfg = { ...cfg, signingPrivateKeyPem: realPem };

  // Capture every fetch call so we can assert on the second one (POST /v3/payments).
  let fetchSpy: ReturnType<typeof vi.fn>;

  // Provider always passes strings to fetch, so this narrowing matches reality.
  const urlOf = (input: string | URL | Request): string =>
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  beforeEach(() => {
    fetchSpy = vi.fn((input: string | URL | Request) => {
      const u = urlOf(input);
      if (u.endsWith('/connect/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 'tok-abc', expires_in: 3600, token_type: 'Bearer' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (u.endsWith('/v3/payments')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'tl-pay-fake-1',
              resource_token: 'res-token-fake',
              status: 'authorization_required',
            }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      throw new Error(`Unexpected fetch: ${u}`);
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs an external_account beneficiary built from the input.beneficiary', async () => {
    const provider = new TrueLayerSandboxProvider(liveCfg);
    const result = await provider.initiate({
      paymentId: '019e137a-0420-75e4-8f74-90e657d09250',
      amountPence: 1234,
      currency: 'GBP',
      payerUserId: 'payer-abc',
      collectorUserId: 'collector-xyz',
      reference: 'gdp-019e137a',
      beneficiary: {
        sortCode: '040668',
        accountNumber: '00079660',
        accountHolderName: 'Callum Davies',
      },
    });

    // Two calls: token + payment
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const [paymentUrl, paymentInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(paymentUrl).toBe('https://api.truelayer-sandbox.com/v3/payments');

    const headers = paymentInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-abc');
    expect(headers['Idempotency-Key']).toBe('019e137a-0420-75e4-8f74-90e657d09250');
    expect(headers['Tl-Signature']).toMatch(/.+\.\..+/); // detached JWS: header..signature

    const body = JSON.parse(paymentInit.body as string) as {
      amount_in_minor: number;
      currency: string;
      payment_method: {
        type: string;
        provider_selection: { type: string };
        beneficiary: {
          type: string;
          account_holder_name: string;
          reference: string;
          account_identifier: { type: string; sort_code: string; account_number: string };
        };
      };
      user: { id: string; name: string; email: string };
      metadata: Record<string, string>;
    };

    expect(body.amount_in_minor).toBe(1234);
    expect(body.currency).toBe('GBP');
    expect(body.payment_method.type).toBe('bank_transfer');
    expect(body.payment_method.provider_selection.type).toBe('user_selected');
    expect(body.payment_method.beneficiary.type).toBe('external_account');
    expect(body.payment_method.beneficiary.account_holder_name).toBe('Callum Davies');
    expect(body.payment_method.beneficiary.reference).toBe('gdp-019e137a');
    expect(body.payment_method.beneficiary.account_identifier).toEqual({
      type: 'sort_code_account_number',
      sort_code: '040668',
      account_number: '00079660',
    });
    expect(body.user.id).toMatch(/^[0-9a-f-]{36}$/); // UUIDv5 from payer-abc
    expect(body.metadata).toEqual({
      gdp_payment_id: '019e137a-0420-75e4-8f74-90e657d09250',
      gdp_payer_user_id: 'payer-abc',
      gdp_collector_user_id: 'collector-xyz',
    });

    // Hosted-payment-page URL embeds the TL-returned ids in the fragment.
    expect(result.providerPaymentId).toBe('tl-pay-fake-1');
    expect(result.authorizationUrl).toContain('https://payment.truelayer-sandbox.com/payments#');
    expect(result.authorizationUrl).toContain('payment_id=tl-pay-fake-1');
    expect(result.authorizationUrl).toContain('resource_token=res-token-fake');
  });

  it('produces stable user.id across repeated calls for the same payerUserId', async () => {
    const provider = new TrueLayerSandboxProvider(liveCfg);
    const baseInput = {
      paymentId: '019e137a-0420-75e4-8f74-90e657d09250',
      amountPence: 100,
      currency: 'GBP' as const,
      collectorUserId: 'collector-xyz',
      reference: 'gdp-1',
      beneficiary: {
        sortCode: '040668',
        accountNumber: '00079660',
        accountHolderName: 'Callum Davies',
      },
    };

    await provider.initiate({ ...baseInput, payerUserId: 'payer-abc' });
    await provider.initiate({
      ...baseInput,
      payerUserId: 'payer-abc',
      paymentId: '019e137b-9999-75e4-8f74-90e657d09250',
    });

    // Token cached after first call → subsequent calls skip /connect/token.
    // Calls: [0] /connect/token, [1] /v3/payments, [2] /v3/payments.
    const firstBody = JSON.parse((fetchSpy.mock.calls[1]![1] as RequestInit).body as string) as {
      user: { id: string };
    };
    const secondBody = JSON.parse((fetchSpy.mock.calls[2]![1] as RequestInit).body as string) as {
      user: { id: string };
    };
    expect(firstBody.user.id).toBe(secondBody.user.id);
  });

  it('reuses the cached access token across calls (only one /connect/token request)', async () => {
    const provider = new TrueLayerSandboxProvider(liveCfg);
    const input = {
      paymentId: '019e137a-0420-75e4-8f74-90e657d09250',
      amountPence: 100,
      currency: 'GBP' as const,
      payerUserId: 'p',
      collectorUserId: 'c',
      reference: 'gdp-1',
      beneficiary: {
        sortCode: '040668',
        accountNumber: '00079660',
        accountHolderName: 'X',
      },
    };
    await provider.initiate(input);
    await provider.initiate({ ...input, paymentId: '019e137b-9999-75e4-8f74-90e657d09250' });
    const tokenCalls = fetchSpy.mock.calls.filter(([u]) => String(u).endsWith('/connect/token'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('throws PAYMENT_PROVIDER_ERROR with TL response body on non-2xx', async () => {
    fetchSpy.mockImplementation((input: string | URL | Request) => {
      const u = urlOf(input);
      if (u.endsWith('/connect/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ access_token: 't', expires_in: 3600, token_type: 'Bearer' }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_parameters' }), { status: 400 }),
      );
    });
    const provider = new TrueLayerSandboxProvider(liveCfg);
    try {
      await provider.initiate({
        paymentId: '019e137a-0420-75e4-8f74-90e657d09250',
        amountPence: 100,
        currency: 'GBP',
        payerUserId: 'p',
        collectorUserId: 'c',
        reference: 'r',
        beneficiary: {
          sortCode: '040668',
          accountNumber: '00079660',
          accountHolderName: 'X',
        },
      });
      throw new Error('expected throw');
    } catch (err) {
      const e = err as { code?: string; details?: { status?: number; body?: string } };
      expect(e.code).toBe('PAYMENT_PROVIDER_ERROR');
      expect(e.details?.status).toBe(400);
      expect(e.details?.body).toContain('invalid_parameters');
    }
  });
});
