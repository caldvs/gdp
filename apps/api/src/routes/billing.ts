import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth } from '../middleware/auth.js';
import { callerOf } from '../context/caller.js';
import type { IdTokenVerifier } from '../services/auth.js';
import type { TableFeeService } from '../services/billing/tableFee.js';

export interface BillingRoutesDeps {
  idTokenVerifier?: IdTokenVerifier;
  tableFees: TableFeeService;
}

const StartTableFeeSchema = z.object({ billId: z.string().uuid() });
const StartCreditPackSchema = z.object({ returnTo: z.string().max(200).optional() });

export const buildBillingRoutes = (deps: BillingRoutesDeps): Hono => {
  const r = new Hono();

  // Lead starts paying the fee for a bill; returns the embedded form's client secret.
  r.post(
    '/table-fee',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', StartTableFeeSchema),
    async (c) => {
      const { billId } = c.req.valid('json');
      const result = await deps.tableFees.startCheckout({ caller: callerOf(c), billId });
      return c.json({ client_secret: result.clientSecret, amountPence: result.amountPence });
    },
  );

  // A credit pack (#169): 10 credits for £5, in the same embedded form.
  r.post(
    '/credit-packs',
    requireAuth(deps.idTokenVerifier),
    zValidator('json', StartCreditPackSchema),
    async (c) => {
      const { returnTo } = c.req.valid('json');
      const result = await deps.tableFees.startCreditPack({
        caller: callerOf(c),
        ...(returnTo ? { returnTo } : {}),
      });
      return c.json({
        client_secret: result.clientSecret,
        amountPence: result.amountPence,
        credits: result.credits,
      });
    },
  );

  // Whether a pack's payment has been recorded; checks Stripe if the webhook is late.
  r.get('/credit-packs/:checkoutSessionId', requireAuth(deps.idTokenVerifier), async (c) => {
    const id = c.req.param('checkoutSessionId');
    if (!/^cs_[A-Za-z0-9_]+$/.test(id)) {
      return c.json({ recorded: false, boughtCredits: 0 });
    }
    return c.json(
      await deps.tableFees.creditPackStatus({ caller: callerOf(c), checkoutSessionId: id }),
    );
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
    const status = await deps.tableFees.status({
      caller: callerOf(c),
      billId: c.req.param('billId'),
      ...(sessionId && /^cs_[A-Za-z0-9_]+$/.test(sessionId)
        ? { checkoutSessionId: sessionId }
        : {}),
    });
    return c.json(status);
  });

  return r;
};
