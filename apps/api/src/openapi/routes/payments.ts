import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { params, responses } from '../common.js';
import { ErrorResponse, Session, Payment, InitiatePaymentResponse } from '../schemas.js';

export const markParticipantReceived = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/participants/{userId}/received',
  operationId: 'markParticipantReceived',
  summary: 'Collector marks everything a guest owes as received',
  description: `For when the lead sees the transfer land (a banking app notification) before, or
instead of, the guest saying they've paid. Confirms every payment the guest says
they've sent, closes one opened but not sent, and records the rest of what they owe
now as one more payment, already \`succeeded\`, so the guest is settled. Idempotent:
with nothing left to collect it changes nothing. A guest who claims more afterwards
owes the difference, as with any top-up.

#220: a guest who verified a number when they joined (#214) gets one
text saying it arrived, with a link to the bill (\`/b/{token}\`, 30 days).
Once per guest per bill; never more than 30 texts a bill.
`,
  tags: ['payments'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
      userId: z.string().meta({ description: 'The guest whose money arrived' }),
    }),
  },
  responses: {
    200: {
      description: 'Session, with the guest paid up',
      content: {
        'application/json': { schema: Session },
      },
    },
    401: responses.Unauthorized,
    404: {
      description: 'Session or guest not found, or caller is not the collector',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    409: {
      description: 'Session is in setup or deleted',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const initiatePayment = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/payments',
  operationId: 'initiatePayment',
  summary: 'Initiate a payment from the current participant to the collector',
  description: `The current user must be a guest at the table, and payments must be open: every line claimed
(every unit, every spot in a split), the lead has opened them early (\`open-payments\`), or the
bill is locked or closed. Otherwise \`409 PAYMENTS_NOT_OPEN\` with the unclaimed item IDs in
\`details\`. Pays what the guest owes now less what they've already sent (#121). Returns the
payment record and the details the guest pays with from their own banking app.
`,
  tags: ['payments'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    headers: z.object({
      'Idempotency-Key': params.IdempotencyKey,
    }),
  },
  responses: {
    201: {
      description: 'Payment created',
      content: {
        'application/json': { schema: InitiatePaymentResponse },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    403: {
      description: 'Caller is not a participant in this session',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    404: responses.NotFound,
    409: {
      description:
        'Payments not open yet (`PAYMENTS_NOT_OPEN`), session in setup or deleted, or nothing to pay',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const getPayment = createRoute({
  method: 'get',
  path: '/v1/payments/{paymentId}',
  operationId: 'getPayment',
  summary: 'Get a payment record',
  description: `Caller must be the payer or the collector for this payment.
`,
  tags: ['payments'],
  request: {
    params: z.object({
      paymentId: params.PaymentId,
    }),
  },
  responses: {
    200: {
      description: 'Payment record',
      content: {
        'application/json': { schema: Payment },
      },
    },
    401: responses.Unauthorized,
    403: {
      description: 'Caller is not authorized to view this payment',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    404: responses.NotFound,
  },
});

export const confirmManualPayment = createRoute({
  method: 'post',
  path: '/v1/payments/{paymentId}/confirm',
  operationId: 'confirmManualPayment',
  summary: 'Collector confirms a manual payment was received',
  description: `The collector marks a guest payment as \`succeeded\` after seeing the funds arrive in
their bank account. Idempotent — confirming a payment already in \`succeeded\` returns
the same payment unchanged.
`,
  tags: ['payments'],
  request: {
    params: z.object({
      paymentId: params.PaymentId,
    }),
  },
  responses: {
    200: {
      description: 'Payment, now in `succeeded`',
      content: {
        'application/json': { schema: Payment },
      },
    },
    401: responses.Unauthorized,
    404: {
      description: 'Payment not found, or caller is not the collector',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    409: {
      description: "Payment is in a state that can't be confirmed",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const markPaymentPaidByPayer = createRoute({
  method: 'post',
  path: '/v1/payments/{paymentId}/mark-paid',
  operationId: 'markPaymentPaidByPayer',
  summary: "Payer claims they've sent the money via their banking app",
  description: `Payer-only. Idempotent — re-claiming returns the same \`payerClaimedPaidAt\` timestamp.
**Does not advance payment status** — only the lead's \`/confirm\` does that. This claim
exists purely as a UX signal: the lead's session view can flag pending payments where
the payer says they've already paid, so the lead knows which ones to confirm next.
`,
  tags: ['payments'],
  request: {
    params: z.object({
      paymentId: params.PaymentId,
    }),
  },
  responses: {
    200: {
      description: 'Payment with `payerClaimedPaidAt` set',
      content: {
        'application/json': { schema: Payment },
      },
    },
    401: responses.Unauthorized,
    404: {
      description: 'Payment not found, or caller is not the payer',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    409: {
      description: 'Payment is not in `pending` (e.g. already succeeded or failed)',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});
