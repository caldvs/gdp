import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { paymentService } from '../services/payments/paymentService.js';
import { AppError } from '../errors/AppError.js';
import type { IdTokenVerifier } from '../services/auth.js';

export interface PaymentGetRouteDeps {
  idTokenVerifier?: IdTokenVerifier;
}

const callerOf = (c: { var: { userId?: string } }): { userId: string } => {
  if (!c.var.userId) throw new AppError('AUTH_MISSING', 'No verified user');
  return { userId: c.var.userId };
};

export const buildPaymentGetRoute = (deps: PaymentGetRouteDeps): Hono => {
  const r = new Hono();

  r.get('/:paymentId', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const paymentId = c.req.param('paymentId');
    const payment = await paymentService.get({ caller, paymentId });
    return c.json(payment);
  });

  return r;
};
