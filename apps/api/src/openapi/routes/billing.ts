import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { responses } from '../common.js';
import {
  StartTableFeeRequest,
  TableFeeCheckout,
  TableFeeStatus,
  SavedCardHold,
  FeeCharge,
  BillingSummary,
  ErrorResponse,
} from '../schemas.js';

export const startTableFeeCheckout = createRoute({
  method: 'post',
  path: '/v1/billing/table-fee',
  operationId: 'startTableFeeCheckout',
  summary: 'Start the £1 hold for a bill',
  description: `Without a credit, sharing a bill puts a £1 hold on the lead's card (#165): authorised
now and always released at settle. Creates a Stripe Checkout Session (manual capture)
for the embedded form (\`ui_mode: form\`) and returns its client secret. The session is
for the lead's Stripe customer with \`setup_future_usage: off_session\` (#228), so the
card is saved for one charge at settle: the round-ups of the guests the lead marked
received. The hold is recorded by the Stripe webhook.
`,
  tags: ['billing'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: StartTableFeeRequest },
      },
    },
  },
  responses: {
    200: {
      description: 'Client secret for the embedded form',
      content: {
        'application/json': { schema: TableFeeCheckout },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description:
        'The fee for this bill is already paid (`TABLE_FEE_PAID`), or none is due (`TABLE_FEE_WAIVED`)',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    502: {
      description: 'Stripe error, or no active price for the fee',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const getTableFeeStatus = createRoute({
  method: 'get',
  path: '/v1/billing/table-fee/{billId}',
  operationId: 'getTableFeeStatus',
  summary: 'Whether the table fee for a bill is paid',
  description: `With \`session_id\`, an unpaid fee is checked with Stripe directly and recorded if that
Checkout Session is the caller's, for this bill, and paid. Covers a late or missing webhook.
`,
  tags: ['billing'],
  request: {
    params: z.object({
      billId: z.uuid(),
    }),
    query: z.object({
      session_id: z
        .string()
        .meta({ description: 'The Checkout Session the page just confirmed (`cs_…`).' })
        .optional(),
      payment_intent: z
        .string()
        .meta({ description: 'A hold on the saved card the page just confirmed (`pi_…`, #228).' })
        .optional(),
    }),
  },
  responses: {
    200: {
      description: 'Fee status',
      content: {
        'application/json': { schema: TableFeeStatus },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
  },
});

export const holdOnSavedCard = createRoute({
  method: 'post',
  path: '/v1/billing/table-fee/saved-card',
  operationId: 'holdOnSavedCard',
  summary: 'Place the £1 hold on the saved card',
  description: `#228: the hold on the card saved with the lead's last hold, in one tap. \`held\` when the
bank authorised it; \`requires_action\` when it wants the lead to confirm (3D Secure):
the page finishes it with Stripe.js and polls the status with \`payment_intent\`.
`,
  tags: ['billing'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: StartTableFeeRequest },
      },
    },
  },
  responses: {
    200: {
      description: 'Held, or waiting for the lead to confirm',
      content: {
        'application/json': { schema: SavedCardHold },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description:
        'The bill already has a hold (`TABLE_FEE_PAID`), or none is due (`TABLE_FEE_WAIVED`)',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    502: {
      description: "The card didn't go through, or a Stripe error",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const getFeeCharge = createRoute({
  method: 'get',
  path: '/v1/billing/fee-charge/{billId}',
  operationId: 'getFeeCharge',
  summary: 'The round-ups charge at settle, to confirm it',
  description: `#228: when the bank wanted the lead to confirm the charge made at settle, this gives the
page the PaymentIntent's client secret and the saved card. Checks with Stripe, so a
charge just confirmed comes back \`charged\`. The lead's own bill only.
`,
  tags: ['billing'],
  request: {
    params: z.object({
      billId: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: 'The charge',
      content: {
        'application/json': { schema: FeeCharge },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
  },
});

export const removeSavedCard = createRoute({
  method: 'delete',
  path: '/v1/billing/card',
  operationId: 'removeSavedCard',
  summary: 'Remove the saved card',
  description: '#228: detaches the card saved with the last hold. The Stripe customer stays.',
  tags: ['billing'],
  responses: {
    204: {
      description: 'Removed (or there was none)',
    },
    401: responses.Unauthorized,
  },
});

export const getMyBilling = createRoute({
  method: 'get',
  path: '/v1/billing/me',
  operationId: 'getMyBilling',
  summary: "The lead's credits this month and the platform fees they've paid",
  tags: ['billing'],
  responses: {
    200: {
      description: 'Credits and fees',
      content: {
        'application/json': { schema: BillingSummary },
      },
    },
    401: responses.Unauthorized,
  },
});
