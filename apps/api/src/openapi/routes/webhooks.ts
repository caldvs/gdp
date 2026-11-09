import { createRoute } from '@hono/zod-openapi';
import { ErrorResponse } from '../schemas.js';

export const stripeWebhook = createRoute({
  method: 'post',
  path: '/webhooks/stripe',
  operationId: 'stripeWebhook',
  summary: 'Stripe event webhook',
  description: `Verified with the \`Stripe-Signature\` header and \`STRIPE_WEBHOOK_SECRET\`.
\`checkout.session.completed\` (and \`checkout.session.async_payment_succeeded\`) with
\`payment_status: paid\` records the bill's table fee. #228:
\`payment_intent.amount_capturable_updated\` records a hold on the saved card, and
\`payment_intent.succeeded\` a round-ups charge the lead confirmed. Every verified event gets \`200\`,
including repeats; an invalid signature gets \`401\`.
`,
  tags: ['webhooks'],
  security: [],
  responses: {
    200: {
      description: 'Event accepted',
    },
    401: {
      description: 'Invalid signature',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});
