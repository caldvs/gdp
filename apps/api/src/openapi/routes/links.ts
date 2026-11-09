import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { params, responses } from '../common.js';
import { BillLinkView } from '../schemas.js';

export const getBillLink = createRoute({
  method: 'get',
  path: '/v1/links/{token}',
  operationId: 'getBillLink',
  summary: "The bill behind a link in a guest's text (#220 G5)",
  description: `No sign-in: the random token is the key. Read-only and live: who had
what, who's paid, the guest the link was sent to (\`isYou\`), and what
nobody claimed. Never any phone number or bank details (ADR-0002).
Works for 30 days after the last text; then 404. 60 lookups per IP
per 10 minutes.
`,
  tags: ['links'],
  security: [],
  request: {
    params: z.object({
      token: params.LinkToken,
    }),
  },
  responses: {
    200: {
      description: 'The bill',
      content: {
        'application/json': { schema: BillLinkView },
      },
    },
    404: responses.NotFound,
    429: responses.RateLimited,
  },
});

export const stopReminders = createRoute({
  method: 'post',
  path: '/v1/links/{token}/stop',
  operationId: 'stopReminders',
  summary: 'Stop reminder texts for this bill (#219)',
  description: `From \`/s/{token}\` in a reminder (a named sender can't take STOP
replies). The guest gets no more reminders about this bill.
Idempotent.
`,
  tags: ['links'],
  security: [],
  request: {
    params: z.object({
      token: params.LinkToken,
    }),
  },
  responses: {
    200: {
      description: 'Stopped',
      content: {
        'application/json': {
          schema: z.object({
            stopped: z.boolean(),
          }),
        },
      },
    },
    404: responses.NotFound,
    429: responses.RateLimited,
  },
});
