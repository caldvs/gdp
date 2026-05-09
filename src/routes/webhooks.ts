import { Hono } from 'hono';
import { paymentService } from '../services/payments/paymentService.js';
import { AppError } from '../errors/AppError.js';
import type { PaymentProvider } from '../services/payments/provider.js';

export interface WebhookRoutesDeps {
  provider: PaymentProvider;
}

export const buildWebhookRoutes = (deps: WebhookRoutesDeps): Hono => {
  const r = new Hono();

  r.post('/truelayer', async (c) => {
    const rawBody = await c.req.text();
    const signature = c.req.header('tl-signature');
    const log = c.var.logger;

    try {
      deps.provider.verifyWebhookSignature({ rawBody, signature });
    } catch (err) {
      // Always log signature failures; never reveal why to the caller.
      log?.warn({ err }, 'webhook signature rejected');
      throw new AppError('AUTH_INVALID', 'Webhook signature rejected');
    }

    const event = deps.provider.parseWebhookEvent(rawBody);
    // applyWebhookEvent returns 'applied' | 'noop' | 'invalid_transition'.
    // All three are 200 acks — webhooks must be idempotent and resilient
    // to out-of-order delivery, so an unchanged state is still a success
    // from the provider's perspective.
    await paymentService.applyWebhookEvent({ event, logger: log });
    return c.body(null, 200);
  });

  return r;
};
