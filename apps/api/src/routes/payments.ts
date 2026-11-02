import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { callerOf } from '../context/caller.js';
import { paymentService } from '../services/payments/paymentService.js';
import type { IdTokenVerifier } from '../services/auth.js';

export interface PaymentGetRouteDeps {
  idTokenVerifier?: IdTokenVerifier;
}

export const buildPaymentGetRoute = (deps: PaymentGetRouteDeps): Hono => {
  const r = new Hono();

  r.get('/:paymentId', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const paymentId = c.req.param('paymentId');
    const payment = await paymentService.get({ caller, paymentId });
    return c.json(payment);
  });

  // The collector confirms they've received the transfer. Idempotent.
  r.post('/:paymentId/confirm', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const paymentId = c.req.param('paymentId');
    const payment = await paymentService.confirmManual({
      caller,
      paymentId,
      logger: c.var.logger,
    });
    return c.json(payment);
  });

  // Payer-only: claim "I've sent the money via my bank". Idempotent.
  // Doesn't change payment status — only the lead's /confirm does that.
  // Sets payerClaimedPaidAt so the lead's UI knows which pending payments
  // are awaiting confirmation.
  r.post('/:paymentId/mark-paid', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const paymentId = c.req.param('paymentId');
    const payment = await paymentService.markPaidByPayer({ caller, paymentId });
    return c.json(payment);
  });

  return r;
};
