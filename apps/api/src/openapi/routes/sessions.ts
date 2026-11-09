import { createRoute } from '@hono/zod-openapi';
import {
  SetPayoutCheckRequestSchema,
  AddShareRequestSchema,
  SetShareWaysRequestSchema,
  SetReadyRequestSchema,
  LockClaimsRequestSchema,
  ReceiptRequestSchema,
} from '../../types/sessions.js';
import { z } from 'zod';
import { params, responses } from '../common.js';
import {
  PostCommentRequest,
  Comment,
  StartProofRequest,
  ProofUploadSlot,
  Proof,
  GuestRemind,
  GuestTexts,
  ErrorResponse,
  Session,
  CreateSessionRequest,
  UpdateSessionRequest,
  GuestJoinRequest,
  GuestJoinStartRequest,
  GuestJoinResponse,
  GuestJoinCodeRefused,
  SessionPreview,
  JoinByCodeRequest,
  ClaimsRequest,
} from '../schemas.js';

export const createSession = createRoute({
  method: 'post',
  path: '/v1/sessions',
  operationId: 'createSession',
  summary: 'Create a session from a bill',
  description: `The caller becomes both the creator and the collector. The session starts in \`setup\`. The join
code is generated but not returned by this endpoint and not visible until \`/share\` is called.
`,
  tags: ['sessions'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: CreateSessionRequest },
      },
    },
  },
  responses: {
    201: {
      description: 'Session created',
      content: {
        'application/json': { schema: Session },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: {
      description: 'Bill not found',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    409: {
      description: 'The bill already has an open session (`SESSION_INVALID_STATE`)',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const previewSession = createRoute({
  method: 'post',
  path: '/v1/sessions/preview',
  operationId: 'previewSession',
  summary: "What the QR's landing page shows before anyone joins",
  description: `For whoever holds the QR (#183): host first name, venue, date, item count,
total incl. service and the first names of everyone at the table. Nothing
about bank details (ADR-0002). No sign-in; at most 60 per IP address every
10 minutes.
`,
  tags: ['sessions'],
  security: [],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: JoinByCodeRequest },
      },
    },
  },
  responses: {
    200: {
      description: 'The bill as the landing page shows it',
      content: {
        'application/json': { schema: SessionPreview },
      },
    },
    400: responses.BadRequest,
    404: {
      description: "Unknown token, or a bill that isn't open",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    429: {
      description: 'Too many tries from this address (`RATE_LIMITED`).',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const guestJoin = createRoute({
  method: 'post',
  path: '/v1/sessions/guest-join',
  operationId: 'guestJoin',
  summary: 'Join a bill with a name (and a verified number), no account',
  description: `Guests have no account (#183). Seats a new guest at the table and returns a
session token that works for this one session only (its own session, the
bill it's pinned to, its payments, and \`GET /v1/me\`; anything else is 401 \`AUTH_MISSING\`).
At most 20 per IP address an hour, and 60 per table an hour.

#214: where texts are on (\`GET /v1/auth/methods\` says \`sms: true\`), the
guest first gets a 4-digit code from \`POST /v1/sessions/guest-join/start\`
and sends \`requestId\` and \`phoneCode\` here; without them it's 400. A
wrong or expired code answers 200 with \`status: wrong\` (and
\`attemptsLeft\`) or \`status: expired\`. The number is kept for the bill's
texts, apart from the session, and never shown to anyone at the table.
`,
  tags: ['sessions'],
  security: [],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: GuestJoinRequest },
      },
    },
  },
  responses: {
    200: {
      description: 'The code was wrong or has expired (#214)',
      content: {
        'application/json': { schema: GuestJoinCodeRefused },
      },
    },
    201: {
      description: 'Seated; keep the token',
      content: {
        'application/json': { schema: GuestJoinResponse },
      },
    },
    400: responses.BadRequest,
    404: {
      description: "Unknown token, or a bill that isn't taking new people",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    429: {
      description: 'Too many joins (`RATE_LIMITED`).',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const guestJoinStart = createRoute({
  method: 'post',
  path: '/v1/sessions/guest-join/start',
  operationId: 'guestJoinStart',
  summary: 'Text a guest the code that proves their number',
  description: `#214. Only for a bill taking people (\`claiming\`). Texts a 4-digit code
(10 minutes, 5 tries) to a UK mobile, through AWS End User Messaging
SMS (#231). The same limits as phone sign-in: 3 an hour per number,
30 seconds apart, 10 an hour per IP address, 200 an hour in all
(429 \`RATE_LIMITED\`). 503 \`CHANNEL_UNAVAILABLE\` where texts are off.
`,
  tags: ['sessions'],
  security: [],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: GuestJoinStartRequest },
      },
    },
  },
  responses: {
    200: {
      description: "Sent; `requestId` is this tab's secret for the code",
      content: {
        'application/json': {
          schema: z.object({
            requestId: z.string(),
            phone: z.string().meta({ description: 'The number in E.164' }),
          }),
        },
      },
    },
    400: responses.BadRequest,
    404: {
      description: "Unknown token, or a bill that isn't taking new people",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    429: {
      description: 'Too many codes (`RATE_LIMITED`).',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    503: {
      description: "Texts aren't on here (`CHANNEL_UNAVAILABLE`).",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const resolveJoinCode = createRoute({
  method: 'post',
  path: '/v1/sessions/by-code',
  operationId: 'resolveJoinCode',
  summary: 'Resolve a 6-character join code to a session ID',
  description: `Only resolves sessions in \`claiming\` state. Codes for \`setup\` sessions are not active.
At most 30 lookups per user every 10 minutes (429 \`RATE_LIMITED\` with
\`details.retryAfterSeconds\`), so codes can't cheaply be guessed.
`,
  tags: ['sessions'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: JoinByCodeRequest },
      },
    },
  },
  responses: {
    200: {
      description: 'Resolved session id',
      content: {
        'application/json': {
          schema: z.object({
            sessionId: z.uuid(),
          }),
        },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: {
      description: 'Code not found, expired, or attached to a non-claiming session',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    429: {
      description: 'Too many codes tried (`RATE_LIMITED`).',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const getSession = createRoute({
  method: 'get',
  path: '/v1/sessions/{sessionId}',
  operationId: 'getSession',
  summary: 'Get session state including participants',
  description: `For non-creator callers in \`setup\`, the \`joinCode\` field is omitted from the response.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
  },
  responses: {
    200: {
      description: 'Session state',
      content: {
        'application/json': { schema: Session },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
  },
});

export const updateSession = createRoute({
  method: 'patch',
  path: '/v1/sessions/{sessionId}',
  operationId: 'updateSession',
  summary: 'Change how many people the lead expects at the table',
  description: `Lead only. Sets \`expectedDiners\` (lead included), or clears it with
\`null\`. Allowed until the bill is closed or deleted. Display only:
it never changes what anyone owes.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: UpdateSessionRequest },
      },
    },
  },
  responses: {
    200: {
      description: 'Session with the new value',
      content: {
        'application/json': { schema: Session },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: 'The bill is closed or deleted (`SESSION_INVALID_STATE`)',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const shareSession = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/share',
  operationId: 'shareSession',
  summary: 'Creator transitions setup -> claiming, freezing their own claims',
  description: `Creator-only. Transitions the session from \`setup\` to \`claiming\`. Freezes the creator's
\`claimedItemIds\` and sets the creator's \`payment.status\` to \`self_paid\`. Activates the join code
(subsequent calls to \`/by-code\` will resolve it).

Per ADR-0002 the creator's bank details aren't needed here: they live on the device and
reach guests via the join QR.

When the platform fee is on (Stripe configured), sharing needs one of: the bill's paid fee
(not refunded, not spent on another session), an exempt lead, or the lead's credit for the
month (one free bill a month, UK time). The fee or credit is spent in the same transaction
as the share. Otherwise \`402 TABLE_FEE_REQUIRED\`.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    body: {
      required: false,
      content: {
        'application/json': {
          schema: z.object({
            checkoutSessionId: z
              .string()
              .meta({
                description:
                  'The Checkout Session just paid (`cs_...`), checked with Stripe if the webhook is late.',
              })
              .optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Session, now in `claiming` with the join code visible',
      content: {
        'application/json': { schema: Session },
      },
    },
    401: responses.Unauthorized,
    402: {
      description: 'No paid fee, exemption or credit for this share (`TABLE_FEE_REQUIRED`)',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    403: {
      description: 'Caller is not the creator',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    404: responses.NotFound,
    409: {
      description: 'Session is not in `setup`',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const setSessionPayoutCheck = createRoute({
  method: 'put',
  path: '/v1/sessions/{sessionId}/payout-check',
  operationId: 'setSessionPayoutCheck',
  summary: 'The lead publishes a fingerprint of the bank details in their join link',
  description: `The lead's device sends \`payoutCheck\`, a PBKDF2 fingerprint of the bank
details it puts in the join link's \`#p=\` fragment, salted with the session
id. The details themselves never reach the server (ADR-0002). Guests' apps
recompute it from the link and warn when it doesn't match, so a re-posted
link with someone else's details is caught (#151). Lead only, until the
bill is closed.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: SetPayoutCheckRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'The session, with `payoutCheck`.',
      content: {
        'application/json': { schema: Session },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: 'The bill is closed (`SESSION_INVALID_STATE`).',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const joinSession = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/join',
  operationId: 'joinSession',
  summary: 'Current user joins the session',
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
  },
  responses: {
    200: {
      description: 'Session including the new participant',
      content: {
        'application/json': { schema: Session },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: 'Session is not in `claiming`, or user already a participant',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const setClaims = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/claims',
  operationId: 'setClaims',
  summary: "Replace the current user's claim list",
  description: `Full replacement (not delta). Caller must be the creator (in \`setup\`) or a participant (in
\`claiming\`). Items can be claimed by multiple participants; the cost is split equally with
rounding pennies allocated deterministically at \`lock-claims\` time.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: ClaimsRequest },
      },
    },
  },
  responses: {
    200: {
      description: 'Session reflecting the updated claims',
      content: {
        'application/json': { schema: Session },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: 'Session is in a state where claims cannot be modified by this caller',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const addShare = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/shares',
  operationId: 'addShare',
  summary: 'Caller joins the splitter set for a shared item (ADR-0006)',
  description: `Adds the caller to the share set for \`itemId\`. Idempotent — calling
twice has no effect on the second call.

The item is divided into \`ways\` equal spots and each sharer owes one
spot (largest-remainder rounding, remainder pennies to the lowest
userId). Whoever *starts* the split sets \`ways\` (default 2) — it's
how many people shared the item, not how many have joined yet.
Joining an existing split takes an open spot; if every spot is
already taken, \`ways\` goes up by one (refused with \`SHARE_PAID\` if
someone in the split has already paid). Spots nobody has taken are
unclaimed.

On a line with more than one of something the split covers
\`units\` of it (default: every unit nobody has claimed), and each
sharer owes unitPrice × units / ways. The rest of the line can
still be claimed one at a time. A quantity-1 item is in exactly one
mode session-wide — claim-mode (unit claims via \`/claims\`) or
share-mode.

Splitting an item someone else has claimed (#130) turns their claim
into their spot in a new split with the caller, \`ways\` (default 2),
at once: they're told, not asked. The split's \`activity\` records it
as \`split\`, \`fromUserId\` the former claimer.

- \`409 SESSION_INVALID_STATE\` if \`units\` is more than is left
  unclaimed on the line,
- \`409 CLAIM_SHARE_CONFLICT\` if the caller has claimed it
  themselves (remove the claim first), or
- \`409 SHARE_PAID\` if the person who claimed it has paid.

Editing the caller's share set un-readies them (same rule as
\`/claims\`).
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: AddShareRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated session, with the caller now in the splitter set',
      content: {
        'application/json': { schema: Session },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: `Session is not in setup/claiming or there aren't \`units\` left
unclaimed (\`SESSION_INVALID_STATE\`), the caller has claimed it
(\`CLAIM_SHARE_CONFLICT\`), the split is full and someone in it
has paid or the person who claimed it has paid (\`SHARE_PAID\`),
or a concurrent edit kept winning
(\`SHARE_CONFLICT\`).
`,
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const setShareWays = createRoute({
  method: 'put',
  path: '/v1/sessions/{sessionId}/shares/{itemId}',
  operationId: 'setShareWays',
  summary: 'Someone in a split changes how many ways it is divided',
  description: `Only people in the split may call this. \`ways\` can't go below the
number of people already in it (\`SHARE_WAYS_TOO_LOW\`) and can't
change once anyone in it has a pending or succeeded payment
(\`SHARE_PAID\`). Recorded in the split's \`activity\` so the others
in it can be told.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
      itemId: z.uuid(),
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: SetShareWaysRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Updated session',
      content: {
        'application/json': { schema: Session },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: `Caller isn't in the split (\`SHARE_CONFLICT\`), \`ways\` is below the
number of people in it (\`SHARE_WAYS_TOO_LOW\`), someone in it has
paid (\`SHARE_PAID\`), or the session isn't in setup/claiming.
`,
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const removeShare = createRoute({
  method: 'delete',
  path: '/v1/sessions/{sessionId}/shares/{itemId}',
  operationId: 'removeShare',
  summary: 'Caller leaves the splitter set for a shared item (ADR-0006)',
  description: `Removes the caller from the share set for \`itemId\`. Idempotent —
no-op if not in the set. The number of ways stays the same (the
caller's spot reopens). If the caller is the last sharer, the
item reverts to no-share-at-all.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
      itemId: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Updated session',
      content: {
        'application/json': { schema: Session },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: 'Session is in a state where shares cannot be modified',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const setReady = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/ready',
  operationId: 'setReady',
  summary: "Non-creator participant signals 'I'm done claiming'",
  description: `Per-diner readiness flag used by the hybrid claim model. Each guest
toggles this when they're done claiming items; the lead's lock-claims
precondition checks all non-creator participants are ready (unless
\`force: true\`). The creator cannot use this endpoint — they signal
readiness implicitly via \`lock-claims\`.

Editing claims (\`POST /claims\`) un-readies the participant.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: SetReadyRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: "Session, with the caller's readyToLock flipped",
      content: {
        'application/json': { schema: Session },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: 'Session not in `claiming`, or caller is the creator',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const lockClaims = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/lock-claims',
  operationId: 'lockClaims',
  summary: 'Creator locks claims and transitions claiming -> paying',
  description: `Creator-only. All bill items must be claimed by ≥1 participant; otherwise returns
\`409 CLAIMS_INCOMPLETE\` with the list of unclaimed item IDs in \`details\`.

All non-creator participants must have \`readyToLock: true\` (set via
\`POST /ready\`); otherwise returns \`409 PARTICIPANTS_NOT_READY\` with
the list of un-ready user IDs in \`details\`. The order of these
checks: items completeness first, then readiness.

Pass \`force: true\` in the body to skip the readiness precondition
(e.g. a guest dropped off). Items completeness is always required.

On success, computes \`owedPence\` for every participant and freezes
claims.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    body: {
      required: false,
      content: {
        'application/json': { schema: LockClaimsRequestSchema },
      },
    },
  },
  responses: {
    200: {
      description: 'Session, now in `paying` with `owedPence` computed',
      content: {
        'application/json': { schema: Session },
      },
    },
    401: responses.Unauthorized,
    403: {
      description: 'Caller is not the creator',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    404: responses.NotFound,
    409: {
      description: `One of: session not in \`claiming\`, items unclaimed
(\`CLAIMS_INCOMPLETE\`), or participants not ready
(\`PARTICIPANTS_NOT_READY\`).
`,
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const closeSession = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/close',
  operationId: 'closeSession',
  summary: 'Creator closes the bill (session becomes `settled`)',
  description: `"I've stopped waiting at the table." Anything still unclaimed is the
creator's by implication. Guests who still owe can pay afterwards.
Every diner is emailed their bill report (see \`emailSessionReport\`).
Idempotent: closing a settled session returns it unchanged and sends
nothing.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
  },
  responses: {
    200: {
      description: 'Session, now in `settled`',
      content: {
        'application/json': { schema: Session },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: 'Session is `setup` or `abandoned`',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const emailSessionReport = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/report',
  operationId: 'emailSessionReport',
  summary: 'Email the caller their bill report',
  description: `The lead's report lists every diner (themselves included): what each
had, their share of service and tax, and whether they've paid. A
guest's lists only what they had and paid. Works while the bill is
open (current state) and after it's closed. Nobody is emailed
automatically at close (#221: the lead's comes the next morning).
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
  },
  responses: {
    202: {
      description: "Report sent to the caller's email",
      content: {
        'application/json': {
          schema: z.object({
            sent: z.boolean(),
          }),
        },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: 'Session is `setup` or `abandoned`',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const abandonSession = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/abandon',
  operationId: 'abandonSession',
  summary: 'Creator marks the session abandoned (terminal)',
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
  },
  responses: {
    200: {
      description: 'Session, now in `abandoned`',
      content: {
        'application/json': { schema: Session },
      },
    },
    401: responses.Unauthorized,
    403: {
      description: 'Caller is not the creator',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    404: responses.NotFound,
    409: {
      description: 'Session is already `settled`',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const getGuestTexts = createRoute({
  method: 'get',
  path: '/v1/sessions/{sessionId}/texts',
  operationId: 'getGuestTexts',
  summary: 'What Remind can do for each guest (#219)',
  description: `The lead only. Per guest: \`ready\` (*Remind* sends a text), \`today\`
(reminded in the last day), \`used_up\` (three reminders sent),
\`stopped\` (they opted out), \`no_number\`, \`not_owed\` or \`not_open\`
(payments aren't open yet). \`enabled: false\` where texts are off.
Never a phone number.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
  },
  responses: {
    200: {
      description: 'Reminder state per guest',
      content: {
        'application/json': { schema: GuestTexts },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
  },
});

export const remindGuest = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/participants/{userId}/remind',
  operationId: 'remindGuest',
  summary: 'The lead texts a guest who still owes a reminder (#219)',
  description: `One text by AWS SMS: what they owe, the bill's link
(\`/b/{token}\`) and a link to stop reminders (\`/s/{token}\`). At most
one a day per guest and three in all (the automatic one counts),
and never more than 30 texts a bill. 429 when it's too soon or used
up; 409 when the guest can't be reminded (paid, no number, opted
out, payments not open); 503 where texts are off.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
      userId: z.string().meta({ description: 'The guest to remind' }),
    }),
  },
  responses: {
    200: {
      description: "Sent; the guest's reminder state now",
      content: {
        'application/json': { schema: GuestRemind },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: "This guest can't be reminded",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    429: responses.RateLimited,
    503: {
      description: "Texts aren't available here",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const emailReceipt = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/receipt',
  operationId: 'emailReceipt',
  summary: 'A guest has their receipt emailed (#220)',
  description: `From *All square*: what they had, their part of service and the
discount, and what they paid. No bank details. Not a sign-in and not
saved to an account: the address is kept with the bill only and goes
with it. Three sends per guest per bill, five a day to any one
address. Not for the lead (their report is \`/report\`).
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: ReceiptRequestSchema },
      },
    },
  },
  responses: {
    202: {
      description: 'Receipt sent',
      content: {
        'application/json': {
          schema: z.object({
            sent: z.boolean(),
          }),
        },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: 'Session is `setup` or `abandoned`',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    429: responses.RateLimited,
  },
});

export const openPayments = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/open-payments',
  operationId: 'openPayments',
  summary: 'The lead opens payments before every line is claimed',
  description: `Lead only (#216). Payments open by themselves once every line is claimed (every unit,
every spot in a split); this opens them early. Sets \`paymentsOpenedAt\`. Amounts don't
change, and whatever nobody has claimed is the lead's at settle. Idempotent: the first
time is kept.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
  },
  responses: {
    200: {
      description: 'Session, with `paymentsOpenedAt`',
      content: {
        'application/json': { schema: Session },
      },
    },
    401: responses.Unauthorized,
    404: {
      description: 'Session not found, or caller is not the lead',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    409: {
      description: 'Session is in setup, closed or deleted',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const listComments = createRoute({
  method: 'get',
  path: '/v1/sessions/{sessionId}/comments',
  operationId: 'listComments',
  summary: "The bill's comments, oldest first",
  description: `Anyone at the table (#218). Text only; at most the latest 200. Kept with the session and
gone when it expires (30 days).
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
  },
  responses: {
    200: {
      description: 'Comments, oldest first',
      content: {
        'application/json': {
          schema: z.object({
            comments: z.array(Comment),
          }),
        },
      },
    },
    401: responses.Unauthorized,
    404: {
      description: "Session not found, or caller isn't at the table",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const postComment = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/comments',
  operationId: 'postComment',
  summary: 'Write a comment on the bill',
  description: `Anyone at the table (#218), e.g. "Sent mine by Monzo". Plain text, trimmed, 1–280
characters; never turned into links. 30 per person per bill per hour.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: PostCommentRequest },
      },
    },
  },
  responses: {
    201: {
      description: 'The comment',
      content: {
        'application/json': { schema: Comment },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: {
      description: "Session not found, or caller isn't at the table",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    409: {
      description: 'The bill was deleted',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    429: responses.RateLimited,
  },
});

export const startProof = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/proofs',
  operationId: 'startProof',
  summary: 'Start uploading a proof-of-payment screenshot',
  description: `A guest (not the lead) at a live bill (#226). The browser crops the screenshot and
re-encodes it as JPEG (no EXIF) first; only that is uploaded, with a presigned PUT
(\`content-type: image/jpeg\`, exactly \`sizeBytes\`, at most 2 MB, 5 minutes). Then call
\`…/proofs/{proofId}/sent\`. At most 3 per guest per bill; deleted after 30 days.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: StartProofRequest },
      },
    },
  },
  responses: {
    201: {
      description: 'Where to PUT the image',
      content: {
        'application/json': { schema: ProofUploadSlot },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: {
      description: "Session or screenshot not found, or caller isn't at the table",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    409: {
      description: 'The bill is deleted or not shared yet',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    429: responses.RateLimited,
  },
});

export const listProofs = createRoute({
  method: 'get',
  path: '/v1/sessions/{sessionId}/proofs',
  operationId: 'listProofs',
  summary: 'Proof-of-payment screenshots',
  description: `The lead gets every guest's; a guest gets their own (#226). Sent ones only, oldest first,
each with a signed URL that lasts 5 minutes.
`,
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
    }),
  },
  responses: {
    200: {
      description: 'Screenshots',
      content: {
        'application/json': {
          schema: z.object({
            proofs: z.array(Proof),
          }),
        },
      },
    },
    401: responses.Unauthorized,
    404: {
      description: "Session or screenshot not found, or caller isn't at the table",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const proofSent = createRoute({
  method: 'post',
  path: '/v1/sessions/{sessionId}/proofs/{proofId}/sent',
  operationId: 'proofSent',
  summary: 'The screenshot has uploaded',
  description: 'Checks the object is there, then shows it to the lead (#226). Idempotent.',
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
      proofId: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: 'The screenshot',
      content: {
        'application/json': { schema: Proof },
      },
    },
    401: responses.Unauthorized,
    404: {
      description: "Session or screenshot not found, or caller isn't at the table",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    409: {
      description: 'Nothing uploaded yet',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const deleteProof = createRoute({
  method: 'delete',
  path: '/v1/sessions/{sessionId}/proofs/{proofId}',
  operationId: 'deleteProof',
  summary: 'Remove your screenshot',
  description: 'The guest who sent it (#226). Deletes the image too.',
  tags: ['sessions'],
  request: {
    params: z.object({
      sessionId: params.SessionId,
      proofId: z.uuid(),
    }),
  },
  responses: {
    204: {
      description: 'Removed',
    },
    401: responses.Unauthorized,
    404: {
      description: "Session or screenshot not found, or caller isn't at the table",
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});
