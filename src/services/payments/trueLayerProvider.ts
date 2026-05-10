import { sign, verify, SignatureError, type HttpMethod } from 'truelayer-signing';
import { v5 as uuidv5 } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../errors/AppError.js';
import type { Logger } from '../../logging/logger.js';
import type { WebhookEventType } from './stateMachine.js';
import type {
  InitiatePaymentInput,
  InitiatedPayment,
  PaymentProvider,
  VerifyWebhookInput,
  WebhookEvent,
} from './provider.js';

export interface TrueLayerSandboxProviderConfig {
  environment: 'sandbox' | 'live';
  clientId: string;
  clientSecret: string;
  signingKid: string;
  signingPrivateKeyPem: string;
  merchantAccountId: string;
  /** Where TL bounces the user-agent after the hosted payment page completes. */
  returnUri: string;
  logger?: Logger;
}

const ENV_URLS = {
  sandbox: {
    auth: 'https://auth.truelayer-sandbox.com/connect/token',
    api: 'https://api.truelayer-sandbox.com',
    hpp: 'https://payment.truelayer-sandbox.com/payments',
    jwks: 'https://webhooks.truelayer-sandbox.com/.well-known/jwks',
  },
  live: {
    auth: 'https://auth.truelayer.com/connect/token',
    api: 'https://api.truelayer.com',
    hpp: 'https://payment.truelayer.com/payments',
    jwks: 'https://webhooks.truelayer.com/.well-known/jwks',
  },
} as const;

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().int().positive(),
  token_type: z.string(),
});

const PaymentCreatedSchema = z.object({
  id: z.string(),
  resource_token: z.string(),
  status: z.string(),
});

// TL webhook event envelope. We only consume `type` + `payment_id`;
// other fields are ignored intentionally so a richer event still parses.
const WebhookEnvelopeSchema = z
  .object({
    type: z.string(),
    payment_id: z.string().optional(),
    failure_stage: z.string().optional(),
    failure_reason: z.string().optional(),
  })
  .passthrough();

const TYPE_MAP: Record<string, WebhookEventType> = {
  payment_authorized: 'authorized',
  payment_executed: 'executed',
  payment_settled: 'settled',
  payment_failed: 'failed',
  // TL emits `refund_executed` etc. on a separate refunds resource — we
  // surface only the payment-level event for now.
  payment_refunded: 'refunded',
};

// Events TL fires that we don't act on. Listed explicitly (rather than
// silently swallowing every unknown type) so anything new from TL surfaces
// in the warn log instead of being silently dropped.
const IGNORED_TYPES = new Set<string>([
  // Funds available for crediting; informational, fires after `settled`.
  'payment_creditable',
]);

const JWKS_TTL_MS = 60 * 60 * 1000; // 1 hour

// TrueLayer requires `user.id` to be a UUID, but our payer ids are Google
// `sub` claims (numeric strings) or synthetic ids in tests. Derive a stable
// UUIDv5 from our id so TL sees the same value per user across payments.
const TL_USER_ID_NAMESPACE = '6d1e7a8a-0f3c-4d5b-8e2a-9c1f7e2a4d3b';

export class TrueLayerSandboxProvider implements PaymentProvider {
  readonly name = 'truelayer' as const;
  private readonly urls: (typeof ENV_URLS)[keyof typeof ENV_URLS];
  private cachedToken: { token: string; expiresAtMs: number } | null = null;
  private cachedJwks: { jwks: string; fetchedAtMs: number } | null = null;

  constructor(private readonly config: TrueLayerSandboxProviderConfig) {
    if (!config.clientId) throw new Error('TrueLayer: clientId required');
    if (!config.clientSecret) throw new Error('TrueLayer: clientSecret required');
    if (!config.signingKid) throw new Error('TrueLayer: signingKid required');
    if (!config.signingPrivateKeyPem) {
      throw new Error('TrueLayer: signingPrivateKeyPem required');
    }
    if (!config.merchantAccountId) {
      throw new Error('TrueLayer: merchantAccountId required');
    }
    if (!config.returnUri) throw new Error('TrueLayer: returnUri required');
    this.urls = ENV_URLS[config.environment];
  }

  async initiate(input: InitiatePaymentInput): Promise<InitiatedPayment> {
    const accessToken = await this.getAccessToken();

    const body = JSON.stringify({
      amount_in_minor: input.amountPence,
      currency: input.currency,
      payment_method: {
        type: 'bank_transfer',
        provider_selection: {
          type: 'user_selected',
          scheme_selection: { type: 'instant_only', allow_remitter_fee: false },
        },
        beneficiary: {
          type: 'merchant_account',
          merchant_account_id: this.config.merchantAccountId,
          reference: input.reference,
        },
      },
      user: {
        // Sandbox doesn't validate the name/email; prod will want the
        // payer's User.displayName + verified email instead.
        id: uuidv5(input.payerUserId, TL_USER_ID_NAMESPACE),
        name: `GDP user ${input.payerUserId.slice(0, 8)}`,
        email: `gdp-${input.payerUserId.slice(0, 8)}@example.test`,
      },
      metadata: {
        gdp_payment_id: input.paymentId,
        gdp_payer_user_id: input.payerUserId,
        gdp_collector_user_id: input.collectorUserId,
      },
    });

    const path = '/v3/payments';
    const idempotencyKey = input.paymentId;
    const tlSignature = sign({
      kid: this.config.signingKid,
      privateKeyPem: this.config.signingPrivateKeyPem,
      method: 'POST' as HttpMethod,
      path,
      headers: { 'Idempotency-Key': idempotencyKey },
      body,
    });

    const res = await fetch(`${this.urls.api}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        'Tl-Signature': tlSignature,
      },
      body,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      this.config.logger?.warn(
        { status: res.status, errBody: errBody.slice(0, 500) },
        'truelayer create payment failed',
      );
      throw new AppError('PAYMENT_PROVIDER_ERROR', `TrueLayer responded ${res.status}`, {
        status: res.status,
        body: errBody.slice(0, 2000),
      });
    }

    const created = PaymentCreatedSchema.parse(await res.json());
    const authorizationUrl = this.buildHostedPaymentPageUrl({
      paymentId: created.id,
      resourceToken: created.resource_token,
    });
    return { providerPaymentId: created.id, authorizationUrl };
  }

  async verifyWebhookSignature(input: VerifyWebhookInput): Promise<void> {
    const signature = input.headers['tl-signature'];
    if (!signature) {
      throw new AppError('AUTH_INVALID', 'Tl-Signature header missing');
    }
    const jwks = await this.getJwks();
    try {
      verify({
        signature,
        jwks,
        method: 'POST' as HttpMethod,
        path: input.path,
        headers: input.headers,
        body: input.rawBody,
      });
    } catch (err) {
      if (err instanceof SignatureError) {
        throw new AppError('AUTH_INVALID', `TrueLayer signature verify failed: ${err.message}`);
      }
      throw err;
    }
  }

  parseWebhookEvent(rawBody: string): WebhookEvent | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new AppError('INVALID_INPUT', 'Webhook body is not valid JSON');
    }
    const env = WebhookEnvelopeSchema.safeParse(parsed);
    if (!env.success) {
      throw new AppError('INVALID_INPUT', 'Webhook payload schema invalid');
    }
    if (IGNORED_TYPES.has(env.data.type)) {
      return null;
    }
    const mapped = TYPE_MAP[env.data.type];
    if (!mapped) {
      // Unknown event — ack so TL doesn't retry forever, but log so we can
      // notice if TL adds something we should be handling.
      this.config.logger?.warn(
        { eventType: env.data.type },
        'truelayer webhook: unknown event type, ignoring',
      );
      return null;
    }
    if (!env.data.payment_id) {
      throw new AppError('INVALID_INPUT', 'Webhook missing payment_id');
    }
    return {
      providerPaymentId: env.data.payment_id,
      type: mapped,
      reason: env.data.failure_reason,
    };
  }

  private buildHostedPaymentPageUrl(args: { paymentId: string; resourceToken: string }): string {
    // HPP reads its config from the URL fragment — never the query string —
    // so the resource_token is not sent to any server other than TL itself.
    const fragment = new URLSearchParams({
      payment_id: args.paymentId,
      resource_token: args.resourceToken,
      return_uri: this.config.returnUri,
    }).toString();
    return `${this.urls.hpp}#${fragment}`;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && this.cachedToken.expiresAtMs - 30_000 > now) {
      return this.cachedToken.token;
    }
    const res = await fetch(this.urls.auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        scope: 'payments',
      }).toString(),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      this.config.logger?.warn(
        { status: res.status, errBody: errBody.slice(0, 500) },
        'truelayer token fetch failed',
      );
      throw new AppError('PAYMENT_PROVIDER_ERROR', `TrueLayer auth responded ${res.status}`);
    }
    const parsed = TokenResponseSchema.parse(await res.json());
    this.cachedToken = {
      token: parsed.access_token,
      expiresAtMs: now + parsed.expires_in * 1000,
    };
    return parsed.access_token;
  }

  private async getJwks(): Promise<string> {
    const now = Date.now();
    if (this.cachedJwks && now - this.cachedJwks.fetchedAtMs < JWKS_TTL_MS) {
      return this.cachedJwks.jwks;
    }
    const res = await fetch(this.urls.jwks);
    if (!res.ok) {
      throw new AppError('PAYMENT_PROVIDER_ERROR', `TrueLayer JWKS fetch responded ${res.status}`);
    }
    const jwks = await res.text();
    this.cachedJwks = { jwks, fetchedAtMs: now };
    return jwks;
  }
}
