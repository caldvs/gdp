import { createRoute } from '@hono/zod-openapi';
import {
  EmailStartRequestSchema,
  EmailVerifyRequestSchema,
  PhoneStartRequestSchema,
  PhoneVerifyRequestSchema,
} from '../../types/auth.js';
import { ProfilePatchSchema } from '../../types/users.js';
import { z } from 'zod';
import { responses } from '../common.js';
import { ErrorResponse, User, PayoutAccount, SessionSummary } from '../schemas.js';

export const startEmailSignIn = createRoute({
  method: 'post',
  path: '/v1/auth/email/start',
  operationId: 'startEmailSignIn',
  summary: 'Email a 6-digit sign-in code',
  description: `Emails a 6-digit code. The subject leads with it ("123456 is your
Pay Me Back code"), so it shows in the phone's notification and can
be typed without opening the email. It works once, for 15 minutes,
and only with the \`requestId\` returned here: the tab that asked
keeps that secret and sends it with the code to
\`POST /v1/auth/email/verify\`. Only hashes of both are stored.

At most one code every 30 seconds and 5 every 15 minutes per
address (counted without \`+tags\` or Gmail dots), 20 an hour per IP
address, and 1000 an hour in all (429 otherwise).

The response is the same whether or not the address has an
account, so addresses can't be enumerated. Email delivery failures
(e.g. SES bounce) also return \`200\` and are logged server-side.

An address on \`TABLE_FEE_EXEMPT_EMAILS\` gets no code: the response
carries \`token\` and \`user\` instead of \`requestId\`, and the caller is
signed in.
`,
  tags: ['identity'],
  security: [],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: EmailStartRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Code sent (or treated as sent).',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            requestId: z
              .string()
              .meta({
                description:
                  'Everyone but exempt addresses. Secret; keep it in the tab that asked.',
              })
              .optional(),
            token: z
              .string()
              .meta({ description: 'Exempt addresses only: the session JWT.' })
              .optional(),
            user: z
              .object({
                userId: z.string(),
                email: z.string(),
                displayName: z.string(),
              })
              .meta({ description: 'Exempt addresses only.' })
              .optional(),
          }),
        },
      },
    },
    400: responses.BadRequest,
    429: {
      description: `\`RATE_LIMITED\`: a code was sent to this address less than 30
seconds ago, 5 have been sent in the last 15 minutes, 20 this
hour from this IP address, or 1000 this hour in all.
\`details.retryAfterSeconds\` says when to try again.
`,
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const verifyEmailSignInCode = createRoute({
  method: 'post',
  path: '/v1/auth/email/verify',
  operationId: 'verifyEmailSignInCode',
  summary: 'Sign in with the emailed code',
  description: `The tab that asked sends its \`requestId\` and the code the person
typed. \`signedIn\` with a session JWT (good for 30 days) for the
right code; the account for that email is found or made. \`wrong\`
with \`attemptsLeft\` otherwise: a request allows 5 tries, right or
wrong. \`expired\` once the code is used up, past 15 minutes, or the
\`requestId\` isn't one we gave out: ask for a new code.

The right code can be entered again by the same tab for 5 minutes
after it's first used (a phone's autofill and a tap can send it
twice), and keeps answering \`signedIn\`. POST so the secret stays
out of logs.
`,
  tags: ['identity'],
  security: [],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: EmailVerifyRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'What the code came to.',
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['signedIn', 'wrong', 'expired']),
            token: z.string().meta({ description: '`signedIn` only: the session JWT.' }).optional(),
            user: z
              .object({
                userId: z.uuid(),
                email: z.email(),
                displayName: z.string(),
              })
              .meta({ description: '`signedIn` only.' })
              .optional(),
            attemptsLeft: z
              .int()
              .min(1)
              .meta({ description: '`wrong` only: tries left on this code.' })
              .optional(),
          }),
        },
      },
    },
    400: responses.BadRequest,
  },
});

export const getSignInMethods = createRoute({
  method: 'get',
  path: '/v1/auth/methods',
  operationId: 'getSignInMethods',
  summary: 'Which ways to sign in are on here',
  description: `#213. \`sms\` (and \`phone\`, the same) is true once texts are set up on
this server (#231: \`SMS_SENDER_ID\`). Email stays on until phone
sign-in is live.
`,
  tags: ['identity'],
  security: [],
  responses: {
    200: {
      description: 'The switched-on methods.',
      content: {
        'application/json': {
          schema: z.object({
            email: z.boolean(),
            phone: z.boolean().meta({ description: 'Phone sign-in is on.' }),
            sms: z.boolean(),
          }),
        },
      },
    },
  },
});

export const startPhoneSignIn = createRoute({
  method: 'post',
  path: '/v1/auth/phone/start',
  operationId: 'startPhoneSignIn',
  summary: 'Send a 4-digit sign-in code to a phone',
  description: `#213, #231. Texts a 4-digit code through AWS End User Messaging SMS,
in our own words. It works for 10 minutes, 5 tries, and only
with the \`requestId\` returned here, sent with the code to
\`POST /v1/auth/phone/verify\`. UK mobiles only for now; the number is
kept as E.164 and never logged whole.

Codes cost money, so the limits are tight: one every 30 seconds and
3 an hour per number, 10 an hour per IP address, 200 an hour in all
(429 otherwise). Without texts set up here it answers 503.
`,
  tags: ['identity'],
  security: [],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: PhoneStartRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Code sent.',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
            requestId: z.string().meta({ description: 'Secret; keep it in the tab that asked.' }),
            phone: z
              .string()
              .meta({ description: 'The number as E.164, to show back to the person.' }),
          }),
        },
      },
    },
    400: responses.BadRequest,
    429: {
      description:
        '`RATE_LIMITED`: see the limits above. `details.retryAfterSeconds` says when to try again.',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    503: {
      description: "`CHANNEL_UNAVAILABLE`: texts aren't on here.",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const verifyPhoneSignInCode = createRoute({
  method: 'post',
  path: '/v1/auth/phone/verify',
  operationId: 'verifyPhoneSignInCode',
  summary: 'Sign in with the phone code',
  description: `#213. Like \`POST /v1/auth/email/verify\`, with a 4-digit code. The
account for the number is found or made; \`isNew\` is true when it
has no name yet, and the web app then asks for a name and an email
for bill emails (\`PATCH /v1/me\`).
`,
  tags: ['identity'],
  security: [],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: PhoneVerifyRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'What the code came to.',
      content: {
        'application/json': {
          schema: z.object({
            status: z.enum(['signedIn', 'wrong', 'expired']),
            token: z.string().meta({ description: '`signedIn` only: the session JWT.' }).optional(),
            isNew: z.boolean().meta({ description: '`signedIn` only: no name yet.' }).optional(),
            user: z
              .object({
                userId: z.uuid(),
                email: z.string().meta({ description: "Where bill emails go; '' if none yet." }),
                displayName: z.string(),
              })
              .meta({ description: '`signedIn` only.' })
              .optional(),
            attemptsLeft: z
              .int()
              .min(1)
              .meta({ description: '`wrong` only: tries left on this code.' })
              .optional(),
          }),
        },
      },
    },
    400: responses.BadRequest,
  },
});

export const testAccountSignIn = createRoute({
  method: 'post',
  path: '/v1/auth/email/test-sign-in',
  operationId: 'testAccountSignIn',
  summary: 'Sign in to a test account without a code (local and dev only)',
  description: `For trying the app as several people at once. Only \`@test.invalid\`
addresses (reserved, so never a real person's), and only where the
server enables it: local and dev, never prod (404 there). A known
address gets its existing account; a new one gets a new account.
`,
  tags: ['identity'],
  security: [],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: EmailStartRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Signed in. Same shape as `openEmailSignInLink`.',
      content: {
        'application/json': {
          schema: z.object({
            token: z.string(),
            user: z.object({
              userId: z.uuid(),
              email: z.email(),
              displayName: z.string(),
            }),
          }),
        },
      },
    },
    400: responses.BadRequest,
    404: {
      description: 'Test accounts are off on this server.',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const getCurrentUser = createRoute({
  method: 'get',
  path: '/v1/me',
  operationId: 'getCurrentUser',
  summary: 'Get the verified caller',
  tags: ['identity'],
  responses: {
    200: {
      description: 'The authenticated user, derived from the verified ID token',
      content: {
        'application/json': { schema: User },
      },
    },
    401: responses.Unauthorized,
  },
});

export const updateCurrentUser = createRoute({
  method: 'patch',
  path: '/v1/me',
  operationId: 'updateCurrentUser',
  summary: 'Set your name and the email bill emails go to',
  description: `#213. A phone account has no name or email until it sets them. The
email is only where bill emails go, not a way to sign in; '' removes
it. Answers with a fresh session JWT, since the name travels in it.
Guests (#183) can't.
`,
  tags: ['identity'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: ProfilePatchSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Saved.',
      content: {
        'application/json': {
          schema: z.object({
            token: z.string(),
            user: z.object({
              userId: z.string(),
              email: z.string(),
              displayName: z.string(),
            }),
          }),
        },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
  },
});

export const signOutEverywhere = createRoute({
  method: 'post',
  path: '/v1/me/sign-out',
  operationId: 'signOutEverywhere',
  summary: 'Sign out everywhere',
  description: `Ends every session token this user holds, on every device: tokens
minted before this call get \`401 AUTH_INVALID\` from then on. The
web app's Sign out calls it.
`,
  tags: ['identity'],
  responses: {
    200: {
      description: 'Signed out everywhere.',
      content: {
        'application/json': {
          schema: z.object({
            ok: z.literal(true),
          }),
        },
      },
    },
    401: responses.Unauthorized,
  },
});

export const setMyPayoutAccount = createRoute({
  method: 'put',
  path: '/v1/me/payout-account',
  operationId: 'setMyPayoutAccount',
  summary: '[DEPRECATED] Accepted but no longer persisted',
  description: `**Deprecated.** Per ADR-0002, the lead's bank details are now device-local
and exchanged peer-to-peer via QR — never stored server-side. This endpoint
still validates the body and returns 200 echoing the supplied account for
compatibility with older clients, but it no longer persists anything.

New clients should not call this. The endpoint will be removed in a future
release.
`,
  deprecated: true,
  tags: ['identity'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: PayoutAccount },
      },
    },
  },
  responses: {
    200: {
      description: `Always returned for valid bodies. The supplied account is echoed back
but **not** persisted.
`,
      content: {
        'application/json': {
          schema: z.object({
            payoutAccount: PayoutAccount,
          }),
        },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
  },
});

export const listMySessions = createRoute({
  method: 'get',
  path: '/v1/me/sessions',
  operationId: 'listMySessions',
  summary: 'List sessions the caller has been part of, most recent first',
  description: `Returns lightweight summaries (no participants list) for sessions where the caller is the
creator or a joined diner. Sessions are sorted by sessionId descending — UUIDv7 is time-ordered
so the newest comes first. The full session can be fetched via GET /v1/sessions/{id}.
`,
  tags: ['identity'],
  request: {
    query: z.object({
      limit: z
        .int()
        .min(1)
        .max(100)
        .default(20)
        .meta({ description: 'Maximum number of summaries to return (1–100, defaults to 20).' })
        .optional(),
    }),
  },
  responses: {
    200: {
      description: 'List of session summaries',
      content: {
        'application/json': {
          schema: z.object({
            sessions: z.array(SessionSummary),
          }),
        },
      },
    },
    401: responses.Unauthorized,
  },
});
