import { Hono } from 'hono';
import type Stripe from 'stripe';
import { AppError } from '../errors/AppError.js';
import type { TableFeeService } from '../services/billing/tableFee.js';

export interface StripeWebhookDeps {
  stripe: Stripe;
  webhookSecret: string;
  tableFees: TableFeeService;
}

export const buildStripeWebhookRoutes = (deps: StripeWebhookDeps): Hono => {
  const r = new Hono();

  r.post('/stripe', async (c) => {
    // Signature is computed over the exact bytes Stripe sent: read the raw body.
    const rawBody = await c.req.text();
    const signature = c.req.header('stripe-signature') ?? '';
    const log = c.var.logger;

    let event: Stripe.Event;
    try {
      event = await deps.stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        deps.webhookSecret,
      );
    } catch (err) {
      log?.warn({ err }, 'stripe webhook signature rejected');
      throw new AppError('AUTH_INVALID', 'Webhook signature rejected');
    }

    const outcome = await deps.tableFees.handleEvent(event);
    log?.info({ eventId: event.id, type: event.type, outcome }, 'stripe webhook');
    return c.body(null, 200);
  });

  return r;
};
