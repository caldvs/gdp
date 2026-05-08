import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import { callerOf } from '../context/caller.js';
import { paymentService } from '../services/payments/paymentService.js';
import type { IdTokenVerifier } from '../services/auth.js';

export interface PaymentGetRouteDeps {
  idTokenVerifier?: IdTokenVerifier;
}

const RETURN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment received</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  margin: 0; padding: 24px; background: #f7f7f8; color: #111; }
.card { max-width: 420px; margin: 12vh auto; background: white; border-radius: 12px;
  padding: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.06); text-align: center; }
h1 { font-size: 20px; margin: 0 0 8px; }
p { color: #555; margin: 0; }
</style>
</head>
<body>
<div class="card">
<h1>Thanks — payment received</h1>
<p>You can close this window and return to Group Dine Pay.</p>
</div>
</body>
</html>`;

export const buildPaymentGetRoute = (deps: PaymentGetRouteDeps): Hono => {
  const r = new Hono();

  // Static route must be declared before the `:paymentId` matcher.
  // Public — no auth — TrueLayer hosted-payment-page bounces the user-agent
  // here after authorisation. State is driven by webhooks; this page is UX only.
  r.get('/return', (c) => c.html(RETURN_PAGE_HTML));

  r.get('/:paymentId', requireAuth(deps.idTokenVerifier), async (c) => {
    const caller = callerOf(c);
    const paymentId = c.req.param('paymentId');
    const payment = await paymentService.get({ caller, paymentId });
    return c.json(payment);
  });

  // Manual mode only: collector confirms they've received the transfer.
  // Idempotent. Drives session settlement when this was the last unpaid guest.
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

  return r;
};
