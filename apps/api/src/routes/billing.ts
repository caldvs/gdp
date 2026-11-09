import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { StartTableFeeRequestSchema } from '../types/billing.js';
import { requireAuth } from '../middleware/auth.js';
import { callerOf } from '../context/caller.js';
import type { IdTokenVerifier } from '../services/auth.js';
import type { TableFeeService } from '../services/billing/tableFee.js';

export interface BillingRoutesDeps {
  idTokenVerifier?: IdTokenVerifier;
  tableFees: TableFeeService;
}

export const buildBillingRoutes = (deps: BillingRoutesDeps): Hono => {
  const r = new Hono();

  // Lead starts paying the fee for a bill; returns the embedded form's client secret.
  r.post(
    '/table-fee',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', StartTableFeeRequestSchema),
    async (c) => {
      const { billId } = c.req.valid('json');
      const result = await deps.tableFees.startCheckout({ caller: callerOf(c), billId });
      return c.json({ client_secret: result.clientSecret, amountPence: result.amountPence });
    },
  );

  // #228: the £1 hold on the card saved with the lead's last hold, in one tap.
  r.post(
    '/table-fee/saved-card',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', StartTableFeeRequestSchema),
    async (c) => {
      const { billId } = c.req.valid('json');
      return c.json(await deps.tableFees.holdOnSavedCard({ caller: callerOf(c), billId }));
    },
  );

  // #228: the round-ups charge the bank wanted the lead to confirm.
  r.get('/fee-charge/:billId', requireAuth(deps.idTokenVerifier), async (c) => {
    return c.json(
      await deps.tableFees.feeCharge({ caller: callerOf(c), billId: c.req.param('billId') }),
    );
  });

  // #228: *Remove* the saved card (Account).
  r.delete('/card', requireAuth(deps.idTokenVerifier), async (c) => {
    await deps.tableFees.removeCard(callerOf(c));
    return c.body(null, 204);
  });

  // The lead's credits this month and the fees they've paid (the account page).
  r.get('/me', requireAuth(deps.idTokenVerifier), async (c) => {
    return c.json(await deps.tableFees.summary(callerOf(c)));
  });

  // Whether the fee is paid yet. The page polls this after confirming. The
  // webhook records the payment; `session_id` lets this check Stripe directly
  // when the webhook is late or never arrives.
  r.get('/table-fee/:billId', requireAuth(deps.idTokenVerifier), async (c) => {
    const sessionId = c.req.query('session_id');
    const intentId = c.req.query('payment_intent');
    const status = await deps.tableFees.status({
      caller: callerOf(c),
      billId: c.req.param('billId'),
      ...(sessionId && /^cs_[A-Za-z0-9_]+$/.test(sessionId)
        ? { checkoutSessionId: sessionId }
        : {}),
      // #228: a hold on the saved card.
      ...(intentId && /^pi_[A-Za-z0-9_]+$/.test(intentId) ? { paymentIntentId: intentId } : {}),
    });
    return c.json(status);
  });

  return r;
};
