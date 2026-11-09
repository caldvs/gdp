/**
 * The API's response and shared shapes, as Zod. openapi.yaml is generated
 * from these and the routes in ./routes (npm run gen:openapi); request
 * bodies are the schemas the routes validate with.
 */
import { z } from 'zod';
import { PayoutAccountSchema as PayoutAccount } from '../types/users.js';
import {
  UploadRequestSchema as UploadRequest,
  ParseRequestSchema as ParseRequest,
  AmendBillRequestSchema as AmendBillRequest,
  ForkBillRequestSchema as ForkBillRequest,
} from '../types/bills.js';
import {
  CreateSessionRequestSchema as CreateSessionRequest,
  UpdateSessionRequestSchema as UpdateSessionRequest,
  GuestJoinRequestSchema as GuestJoinRequest,
  GuestJoinStartRequestSchema as GuestJoinStartRequest,
  JoinByCodeRequestSchema as JoinByCodeRequest,
  ClaimsRequestSchema as ClaimsRequest,
} from '../types/sessions.js';
import { PostCommentRequestSchema as PostCommentRequest } from '../types/comments.js';
import { StartProofRequestSchema as StartProofRequest } from '../types/proofs.js';
import { StartTableFeeRequestSchema as StartTableFeeRequest } from '../types/billing.js';

// Request bodies: the schemas the routes validate with.
export {
  PayoutAccount,
  UploadRequest,
  ParseRequest,
  AmendBillRequest,
  ForkBillRequest,
  CreateSessionRequest,
  UpdateSessionRequest,
  GuestJoinRequest,
  GuestJoinStartRequest,
  JoinByCodeRequest,
  ClaimsRequest,
  PostCommentRequest,
  StartProofRequest,
  StartTableFeeRequest,
};

export const TableFeeCheckout = z
  .object({
    client_secret: z
      .string()
      .meta({ description: 'Pass to Stripe.js `initCheckoutFormSdk` / `CheckoutFormProvider`.' }),
    amountPence: z.int().meta({ description: 'The hold: £1' }),
  })
  .meta({ id: 'TableFeeCheckout' });

export const TableFeeStatus = z
  .object({
    billId: z.uuid(),
    status: z.enum(['held', 'paid', 'unpaid', 'waived', 'free']).meta({
      description: `\`held\`: a £1 hold is on the lead's card for this bill (#165); nothing
is taken until close. \`unpaid\`: no hold or credit yet; \`amountPence\`
is the hold sharing needs. \`paid\`: a fee paid outright, from before
holds.
\`waived\`: the lead's email is on TABLE_FEE_EXEMPT_EMAILS; no fee is due.
\`free\`: the lead has this month's credit, which sharing spends.
`,
    }),
    amountPence: z.int(),
    paidAt: z.iso.datetime().optional(),
    heldAt: z.iso.datetime().optional(),
    creditsLeft: z
      .int()
      .meta({ enum: [0, 1], description: 'Credits left this month (on `free` and `unpaid`).' })
      .optional(),
    nextCreditOn: z.iso
      .date()
      .meta({
        description: 'The 1st of next month, when the next credit comes (on `free` and `unpaid`).',
      })
      .optional(),
  })
  .meta({ id: 'TableFeeStatus' });

export const SavedCardHold = z
  .object({
    status: z.enum(['held', 'requires_action']),
    amountPence: z.int().optional(),
    clientSecret: z.string().meta({ description: 'For Stripe.js handleNextAction' }).optional(),
    paymentIntentId: z.string().optional(),
  })
  .meta({ id: 'SavedCardHold' });

export const CardSummary = z
  .object({
    brand: z.string().meta({ description: '`visa`, `mastercard`…' }).optional(),
    last4: z.string().optional(),
    wallet: z.string().meta({ description: '`apple_pay`, `google_pay`…' }).optional(),
  })
  .meta({ id: 'CardSummary' });

export const FeeCharge = z
  .object({
    billId: z.uuid(),
    status: z.enum(['charged', 'needs_confirming', 'none']),
    amountPence: z.int(),
    clientSecret: z
      .string()
      .meta({ description: 'The PaymentIntent to confirm in the page' })
      .optional(),
    paymentMethodId: z.string().meta({ description: 'The saved card, offered first' }).optional(),
    card: CardSummary.optional(),
  })
  .meta({ id: 'FeeCharge' });

export const BillingSummary = z
  .object({
    card: CardSummary.optional(),
    creditsLeft: z.int().meta({ enum: [0, 1] }),
    nextCreditOn: z.iso.date(),
    paidPence: z.int().meta({ description: 'Every fee paid, refunded ones included' }),
    refundedPence: z.int(),
    fees: z.array(
      z.object({
        billId: z.uuid(),
        sessionId: z.uuid().meta({ description: 'The session this fee shared' }).optional(),
        amountPence: z.int(),
        paidAt: z.iso.datetime(),
        kind: z
          .enum(['hold'])
          .meta({
            description:
              'A £1 hold, counted in `paidPence` only for what was taken at close (`capturedPence`) or charged at settle (`chargePence`).',
          })
          .optional(),
        releasedAt: z.iso.datetime().optional(),
        capturedPence: z
          .int()
          .meta({ description: "What was taken from the hold at close, the guests' part (#167)." })
          .optional(),
        capturedAt: z.iso.datetime().optional(),
        savedCard: z
          .literal(true)
          .meta({
            description:
              '#228: the hold saved the card, so settle charges it the round-ups, no cap.',
          })
          .optional(),
        chargeStatus: z
          .enum(['charged', 'needs_confirming', 'none'])
          .meta({
            description: `#228: the charge at settle on the saved card: the round-ups of the guests the
lead marked received, no cap. \`needs_confirming\`: the bank wants the lead to
confirm it. \`none\`: under 30p, or nobody paid.
`,
          })
          .optional(),
        chargePence: z.int().optional(),
        chargedAt: z.iso.datetime().optional(),
        refundedAt: z.iso.datetime().optional(),
      }),
    ),
    credits: z.array(
      z.object({
        month: z.string().meta({ description: '`yyyy-mm`, UK time' }),
        billId: z.uuid(),
        sessionId: z.uuid(),
        claimedAt: z.iso.datetime(),
        returnedAt: z.iso
          .datetime()
          .meta({ description: 'Given back because nobody joined' })
          .optional(),
      }),
    ),
  })
  .meta({ id: 'BillingSummary' });

export const Comment = z
  .object({
    commentId: z.uuid(),
    userId: z.string(),
    displayName: z.string(),
    text: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Comment' });

export const ProofUploadSlot = z
  .object({
    proofId: z.uuid(),
    url: z.url().meta({ description: 'Presigned PUT, image/jpeg' }),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'ProofUploadSlot' });

export const Proof = z
  .object({
    proofId: z.uuid(),
    userId: z.string(),
    sentAt: z.iso.datetime(),
    url: z.url().meta({ description: 'Signed GET, 5 minutes' }),
  })
  .meta({ id: 'Proof' });

export const ReportLine = z
  .object({
    name: z.string(),
    detail: z.string().optional(),
    pence: z.int(),
  })
  .meta({ id: 'ReportLine' });

export const GuestRemind = z
  .object({
    remind: z.enum(['ready', 'today', 'used_up', 'stopped', 'no_number', 'not_owed', 'not_open']),
    reminders: z.int().min(0).meta({ description: 'Reminders sent so far' }),
    lastRemindedAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'GuestRemind', description: '#219: whether Remind can text this guest now.' });

export const GuestTexts = z
  .object({
    enabled: z.boolean().meta({ description: 'False where texts are off' }),
    guests: z.record(z.string(), GuestRemind).meta({ description: 'By guest userId' }),
  })
  .meta({ id: 'GuestTexts' });

export const BillLinkView = z
  .object({
    sessionId: z.uuid(),
    leadName: z.string(),
    venueName: z.string().optional(),
    dateISO: z.iso.datetime(),
    settled: z.boolean(),
    billTotalPence: z.int(),
    expiresAt: z.iso.datetime().meta({ description: 'When the link stops working' }),
    diners: z.array(
      z.object({
        displayName: z.string(),
        isLead: z.boolean(),
        isYou: z.boolean().meta({ description: 'The guest the link was sent to' }),
        lines: z.array(ReportLine),
        itemsPence: z.int(),
        extrasPence: z.int().meta({ description: 'Their part of service and tax' }),
        discountPence: z.int().meta({ description: "Their part of the bill's discount" }),
        feePence: z.int().meta({ description: 'Their round-up' }),
        totalPence: z.int(),
        paid: z.object({
          kind: z.enum(['lead', 'paid', 'says_paid', 'not_paid']),
          amountPence: z.int().optional(),
        }),
      }),
    ),
    unclaimed: z.array(ReportLine),
    unclaimedPence: z.int().meta({ description: 'Nobody claimed, with its service' }),
  })
  .meta({
    id: 'BillLinkView',
    description: "#220 G5: a bill seen from a guest's text. No numbers, no bank details.",
  });

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z
        .enum([
          'AUTH_MISSING',
          'AUTH_INVALID',
          'AUTH_EXPIRED',
          'INVALID_INPUT',
          'IDEMPOTENCY_CONFLICT',
          'NOT_FOUND',
          'BILL_NOT_FOUND',
          'SESSION_NOT_FOUND',
          'PAYMENT_NOT_FOUND',
          'SESSION_INVALID_STATE',
          'CLAIMS_INCOMPLETE',
          'PAYMENTS_NOT_OPEN',
          'CLAIMS_EXCEED_QUANTITY',
          'PARTICIPANTS_NOT_READY',
          'CLAIM_SHARE_CONFLICT',
          'ITEM_NOT_SHAREABLE',
          'ALREADY_PAID_FOR',
          'SHARE_WAYS_TOO_LOW',
          'SHARE_PAID',
          'SHARE_CONFLICT',
          'PARSE_FAILED',
          'PARSE_LOW_CONFIDENCE',
          'PARSE_TIMEOUT',
          'RATE_LIMITED',
          'PAYMENT_PROVIDER_ERROR',
          'CHANNEL_UNAVAILABLE',
          'TABLE_FEE_PAID',
          'TABLE_FEE_WAIVED',
          'TABLE_FEE_REQUIRED',
          'INTERNAL_ERROR',
        ])
        .meta({ description: 'Stable error code (SCREAMING_SNAKE_CASE)' }),
      message: z.string().meta({ description: 'Human-safe explanation' }),
      requestId: z.string().meta({ description: 'Server request ID; cross-reference in support' }),
      details: z
        .record(z.string(), z.unknown())
        .meta({
          description:
            'Optional structured detail; omitted in production for non-validation errors',
        })
        .optional(),
    }),
  })
  .meta({ id: 'ErrorResponse' });

export const User = z
  .object({
    userId: z.string().meta({ description: 'Google sub claim' }),
    displayName: z.string(),
    email: z.email().optional(),
    avatarUrl: z.url().optional(),
    needsName: z
      .boolean()
      .meta({
        description:
          'A phone account with no name yet (#213); the web app asks for one before anything else.',
      })
      .optional(),
    guestSessionId: z
      .uuid()
      .meta({
        description:
          'Set for a guest who joined with just a name (#183); their token works for this session only.',
      })
      .optional(),
    payoutAccount: PayoutAccount.meta({
      description: `**Deprecated** per ADR-0002. Bank details are now device-local and
exchanged peer-to-peer via QR. The field may still be returned for
users created before the migration but new clients should ignore it
and read the lead's payout from the QR fragment.
`,
      deprecated: true,
    }).optional(),
  })
  .meta({ id: 'User' });

export const Venue = z
  .object({
    placeId: z.string().optional(),
    name: z.string().optional(),
    address: z.string().optional(),
    lat: z.number().meta({ format: 'double' }).optional(),
    lng: z.number().meta({ format: 'double' }).optional(),
  })
  .meta({ id: 'Venue' });

export const BillItem = z
  .object({
    itemId: z
      .uuid()
      .meta({ description: 'Stable across amendments where item identity is preserved' }),
    name: z.string(),
    unitPricePence: z.int().min(0).meta({ format: 'int64' }),
    quantity: z.int().min(1),
    category: z.enum(['food', 'drink', 'other']),
    course: z
      .enum(['starter', 'main', 'side', 'dessert'])
      .meta({
        description:
          "Food items only. The parser's best guess at the course, for grouping in the UI. May be absent.",
      })
      .optional(),
    unsure: z
      .string()
      .max(60)
      .meta({
        description: `The reader's note on a line it couldn't read clearly ("price faded"). The app asks the
lead to confirm these lines before Review bill. Absent on clear lines, and cleared by
any amend.
`,
      })
      .optional(),
  })
  .meta({ id: 'BillItem' });

export const BillDiscount = z
  .object({
    name: z.string(),
    amountPence: z.int().min(1).meta({ format: 'int64', description: 'The amount off.' }),
  })
  .meta({ id: 'BillDiscount' });

export const Bill = z
  .object({
    billId: z.uuid(),
    versionNumber: z.int().min(1),
    creatorUserId: z.string(),
    currency: z.enum(['GBP']),
    subtotalPence: z.int().min(0).meta({ format: 'int64' }),
    taxPence: z.int().min(0).meta({ format: 'int64' }),
    serviceChargePence: z.int().min(0).meta({ format: 'int64' }),
    discounts: z
      .array(BillDiscount)
      .max(20)
      .meta({
        description: `Discounts that aren't one item's (8 Nov 2026), shown under the items and shared by what
each person had, like service, but taken off. A discount on one item is folded into that
item's price instead. Absent on older bills.
`,
      })
      .optional(),
    totalPence: z
      .int()
      .min(0)
      .meta({ format: 'int64', description: 'subtotal + tax + service − the discounts.' }),
    parsedTotalPence: z
      .int()
      .min(0)
      .meta({
        format: 'int64',
        description: `The total printed on the receipt itself, as read by OCR.
Kept alongside the computed \`totalPence\` so the client can
flag a mismatch — typical causes are OCR misreading an item
price, a restaurant arithmetic error, or an undisclosed
discount/tip baked into the printed total. Optional because
old bills predate this field and not every parser surfaces it.
`,
      })
      .optional(),
    items: z.array(BillItem),
    parsedFrom: z.object({
      imageHash: z.string().meta({ description: 'SHA-256 hex of resized image bytes' }),
      parser: z.string().meta({ example: 'eu.anthropic.claude-sonnet-4-6' }),
      parserVersion: z.string().meta({ example: 'v1' }),
      parsedAt: z.iso.datetime(),
      uploadId: z
        .uuid()
        .meta({
          description:
            'Original upload identifier; absent on bills parsed before this field was retained.',
        })
        .optional(),
      source: z
        .enum(['parser', 'cache'])
        .meta({
          description: `Where this bill's read came from: the parser, or the analysis
cache (the same image read before by the same parser
fingerprint, by anyone). Absent on bills from before the cache.
`,
        })
        .optional(),
      analysedAt: z.iso
        .datetime()
        .meta({
          description:
            'When the read this bill came from was made. Absent on bills from before the cache.',
        })
        .optional(),
      forkedFrom: z
        .object({
          billId: z.uuid(),
          versionNumber: z.int().min(1),
        })
        .meta({
          description:
            'Set on a bill made by Start again (`POST /v1/bills/{billId}/fork`): the bill and version it came from.',
        })
        .optional(),
    }),
    venue: Venue.optional(),
    previousVersionId: z.uuid().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Bill' });

export const SessionStatus = z
  .enum(['setup', 'claiming', 'paying', 'settled', 'abandoned'])
  .meta({ id: 'SessionStatus' });

export const ParticipantPaymentEntry = z
  .object({
    paymentId: z.uuid(),
    amountPence: z.int().min(0),
    status: z.enum(['pending', 'succeeded', 'failed']),
    payerClaimedPaidAt: z.iso.datetime().optional(),
    paidAt: z.iso.datetime().optional(),
    reason: z.string().optional(),
  })
  .meta({ id: 'ParticipantPaymentEntry' });

export const ParticipantPayment = z
  .discriminatedUnion('status', [
    z.object({
      status: z.literal('unpaid'),
    }),
    z.object({
      status: z.literal('self_paid'),
    }),
    z.object({
      status: z.literal('pending'),
      paymentId: z.uuid(),
      payerClaimedPaidAt: z.iso
        .datetime()
        .meta({
          description: `Mirrors \`Payment.payerClaimedPaidAt\` — set when the payer hits
\`/v1/payments/{paymentId}/mark-paid\` to claim they've sent the money.
The lead's UI can use this to flag "they say they paid" alongside the
pending payment.
`,
        })
        .optional(),
    }),
    z.object({
      status: z.literal('succeeded'),
      paymentId: z.uuid(),
      paidAt: z.iso.datetime(),
    }),
    z.object({
      status: z.literal('failed'),
      paymentId: z.uuid(),
      reason: z.string(),
    }),
  ])
  .meta({ id: 'ParticipantPayment' });

export const Participant = z
  .object({
    userId: z.string(),
    displayName: z.string(),
    avatarUrl: z.url().optional(),
    claimedItemIds: z.array(z.uuid()),
    sharedItemIds: z.array(z.uuid()).meta({
      description: `Items this participant is sharing with other diners (ADR-0006).
Distinct from \`claimedItemIds\`: a share is one unit of a
quantity-1 item divided equally across all sharers, with
deterministic largest-remainder rounding.
`,
    }),
    owedPence: z
      .int()
      .meta({ format: 'int64', description: 'Computed at lock-claims; absent before then' })
      .optional(),
    payment: ParticipantPayment,
    payments: z
      .array(ParticipantPaymentEntry)
      .meta({
        description: `\`payment\` above is the latest state across these: in flight if
any payment is, else paid if any was. "Paid" doesn't mean nothing
more is owed; compare the sent payments with what's owed now.
Every payment this guest has made to the lead, oldest first (#121:
a guest who claims more after paying tops up the difference). A
\`pending\` payment without \`payerClaimedPaidAt\` was opened but not
sent yet. Absent on sessions from before top-ups.
`,
      })
      .optional(),
    readyToLock: z.boolean().meta({
      description: `True once the diner has signalled they're done claiming via
\`POST /v1/sessions/:id/ready\`. Lead's \`lock-claims\` rejects
with \`PARTICIPANTS_NOT_READY\` unless all non-creator participants
are ready (override with \`force: true\`). Creator is implicitly
ready and cannot toggle this flag.
`,
    }),
  })
  .meta({ id: 'Participant' });

export const ShareActivity = z
  .object({
    kind: z
      .enum(['started', 'joined', 'left', 'ways', 'split'])
      .meta({ description: '`split`: `byUserId` split an item `fromUserId` had claimed (#130).' }),
    byUserId: z.string(),
    fromUserId: z.string().optional(),
    at: z.iso.datetime(),
    fromWays: z.int().optional(),
    toWays: z.int().optional(),
  })
  .meta({ id: 'ShareActivity' });

export const Session = z
  .object({
    sessionId: z.uuid(),
    status: SessionStatus,
    creatorUserId: z.string(),
    collectorUserId: z.string().meta({ description: 'Same as creator for v0' }).optional(),
    billId: z.uuid(),
    pinnedBillVersion: z.int().min(1),
    joinCode: z
      .string()
      .regex(new RegExp('^(?:[A-HJ-NP-Z2-9]{6}|[A-Za-z0-9_-]{22})$'))
      .meta({
        description:
          'Hidden during `setup`; visible to creator after `/share`; visible to participants after they join.',
      })
      .optional(),
    participants: z.array(Participant),
    venue: Venue.meta({
      description: `Denormalised from the pinned bill at session-create time so the
frontend can render a venue strapline without a second round-trip.
Optional — predates this field on old sessions, and not every bill
has a venue the reader could extract.
`,
    }).optional(),
    expectedDiners: z
      .int()
      .min(2)
      .max(99)
      .meta({
        description: `How many people the lead said are eating, lead included. Shown as
"3 of 4 joined"; never used in the money maths. Absent until set.
`,
      })
      .optional(),
    paymentsOpenedAt: z.iso
      .datetime()
      .meta({
        description: `When the lead opened payments before every line was claimed (#216).
Absent if they didn't.
`,
      })
      .optional(),
    allClaimed: z
      .boolean()
      .meta({
        description: `View only (#216): every unit and every spot in a split is claimed.
`,
      })
      .optional(),
    paymentsOpen: z
      .boolean()
      .meta({
        description: `View only (#216): guests can see what they owe and pay. True once
every line is claimed, the lead opens payments early, or the bill
is locked or closed.
`,
      })
      .optional(),
    platformFeePence: z
      .int()
      .min(0)
      .meta({
        description: `The hold that paid for sharing this bill (#165). Guests pay it back
to the lead in proportion to what they ordered (#166). Absent when
a credit, an exempt lead or Stripe being off paid for it.
`,
      })
      .optional(),
    payoutCheck: z
      .string()
      .regex(new RegExp('^[0-9a-f]{64}$'))
      .meta({
        description: `The lead's fingerprint of the bank details in their join link (#151),
set with \`PUT /v1/sessions/{sessionId}/payout-check\`. Absent until the
lead's device sends one.
`,
      })
      .optional(),
    shares: z
      .array(
        z.object({
          itemId: z.uuid(),
          userIds: z.array(z.string()),
          ways: z
            .int()
            .min(1)
            .meta({
              description: `How many people the item is divided between. Each sharer
owes unitPrice × units / ways; \`ways - userIds.length\` spots
are still open.
`,
            }),
          units: z
            .int()
            .min(1)
            .meta({
              description: `How many of the line the split covers (1 when absent). The
rest of the line is claimed one unit at a time.
`,
            })
            .optional(),
          activity: z
            .array(ShareActivity)
            .meta({ description: 'Recent changes to this split, oldest first (last 10).' }),
        }),
      )
      .meta({
        description: `Computed view of share state per ADR-0006. One entry per item
with at least one sharer; \`userIds\` is the splitter set. Server
derives this from participants' \`sharedItemIds\` on every read.
Absent when no items are shared.
`,
      })
      .optional(),
    createdAt: z.iso.datetime(),
    ttlAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'Session' });

export const SessionSummary = z
  .object({
    sessionId: z.uuid(),
    status: SessionStatus,
    creatorUserId: z.string(),
    collectorUserId: z.string(),
    billId: z.uuid(),
    pinnedBillVersion: z.int().min(1),
    joinCode: z.string().regex(new RegExp('^(?:[A-HJ-NP-Z2-9]{6}|[A-Za-z0-9_-]{22})$')).optional(),
    venue: z
      .object({
        name: z.string(),
      })
      .meta({
        description: `Slim venue projection (just \`name\`) for list-view straplines. The full
Venue with placeId/lat/lng/address is available on \`GET /v1/sessions/{id}\`.
Absent when the bill's parsed venue had no name.
`,
      })
      .optional(),
    createdAt: z.iso.datetime(),
    ttlAt: z.iso.datetime().optional(),
    role: z
      .enum(['lead', 'diner'])
      .meta({ description: 'Whether the caller created this session or joined as a diner.' }),
    myOwedPence: z
      .int()
      .min(0)
      .meta({
        description:
          "The caller's locked-in share, present once the session has been locked into paying.",
      })
      .optional(),
    billTotalPence: z
      .int()
      .min(0)
      .meta({ description: 'The total of the bill version the session is pinned to.' })
      .optional(),
    mySharePence: z
      .int()
      .min(0)
      .meta({
        description: `The caller's part of the bill now: their claims and splits plus their part of service
and tax, and a guest's round-up (what the bill page shows them). \`myOwedPence\` once
claims are locked. Absent with \`billTotalPence\` if the bill version can't be read.
`,
      })
      .optional(),
    myPaymentStatus: z.enum(['unpaid', 'self_paid', 'pending', 'succeeded', 'failed']),
    peopleCount: z
      .int()
      .min(0)
      .meta({
        description: 'Open bills the caller leads only. Everyone at the table, the lead included.',
      })
      .optional(),
    toPayCount: z
      .int()
      .min(0)
      .meta({
        description: "Open bills the caller leads only. Guests who haven't paid in full yet.",
      })
      .optional(),
  })
  .meta({ id: 'SessionSummary' });

export const PaymentStatus = z
  .enum(['pending', 'succeeded', 'failed'])
  .meta({ id: 'PaymentStatus' });

export const Payment = z
  .object({
    paymentId: z.uuid(),
    sessionId: z.uuid(),
    payerUserId: z.string(),
    collectorUserId: z.string(),
    amountPence: z.int().min(0).meta({ format: 'int64' }),
    currency: z.enum(['GBP']),
    status: PaymentStatus,
    idempotencyKey: z.uuid().optional(),
    events: z
      .array(
        z.object({
          at: z.iso.datetime(),
          from: PaymentStatus,
          to: PaymentStatus,
          source: z.enum(['api', 'system']),
          note: z.string().optional(),
        }),
      )
      .meta({ description: 'Audit trail of state transitions' })
      .optional(),
    createdAt: z.iso.datetime(),
    payerClaimedPaidAt: z.iso
      .datetime()
      .meta({
        description: `Set when the payer hits \`POST /v1/payments/{paymentId}/mark-paid\` to claim
"I've sent the money via my bank app". Surfaced in the lead's session view so
they know which pending payments are awaiting their \`/confirm\`. Does not advance
payment status — only \`/confirm\` does that.
`,
      })
      .optional(),
  })
  .meta({ id: 'Payment' });

export const UploadSlot = z
  .object({
    status: z.literal('new'),
    uploadId: z.uuid(),
    url: z.url().meta({ description: 'Pre-signed S3 PUT URL (expires in 5 minutes)' }),
    expiresAt: z.iso.datetime(),
    maxBytes: z.int().meta({ description: 'Enforced via Content-Length on the PUT' }),
  })
  .meta({ id: 'UploadSlot' });

export const DuplicateSession = z
  .object({
    sessionId: z.uuid(),
    status: SessionStatus,
  })
  .meta({
    id: 'DuplicateSession',
    description:
      "The bill's live session (setup, claiming or paying: it holds the bill), else the lead's newest session for it when that one is settled. Absent when there's none or it was abandoned.",
  });

export const UploadDuplicate = z
  .object({
    status: z.literal('duplicate'),
    billId: z.uuid().meta({
      description: 'An existing bill matched the supplied image hash; do not upload again',
    }),
    versionNumber: z.int().min(1),
    amended: z.boolean(),
    session: DuplicateSession.optional(),
  })
  .meta({ id: 'UploadDuplicate' });

export const DuplicateContext = z
  .object({
    versionNumber: z.int().min(1).meta({ description: "The bill's latest version" }),
    amended: z.boolean().meta({ description: '`versionNumber > 1`: the lead has changed it' }),
    session: DuplicateSession.optional(),
  })
  .meta({
    id: 'DuplicateContext',
    description:
      "Where the uploader's own bill for a photo they've sent before stands, resolved at request time. The app opens Review bill (saying \"Picked up where you left off\" when `amended`), or the bill's table when `session` is set.",
  });

export const ParsedBill = Bill.extend({
  duplicate: DuplicateContext.optional(),
}).meta({ id: 'ParsedBill' });

export const BillRead = z
  .object({
    readId: z.uuid(),
    status: z.enum(['reading', 'done', 'failed']),
    billId: z.uuid().meta({ description: 'Set when `done`' }).optional(),
    duplicate: DuplicateContext.meta({
      description: "Set when `done` and the photo was this user's own bill from before",
    }).optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional(),
      })
      .meta({ description: "Set when `failed`. `code` is one of the API's error codes." })
      .optional(),
  })
  .meta({ id: 'BillRead' });

export const GuestJoinResponse = z
  .object({
    status: z.enum(['joined']),
    token: z.string().meta({ description: 'Session token for this one session' }),
    session: Session,
  })
  .meta({ id: 'GuestJoinResponse' });

export const GuestJoinCodeRefused = z
  .object({
    status: z.enum(['wrong', 'expired']),
    attemptsLeft: z.int().min(0).optional(),
  })
  .meta({ id: 'GuestJoinCodeRefused' });

export const SessionPreview = z
  .object({
    sessionId: z.uuid(),
    status: z.enum(['setup', 'claiming', 'paying', 'settled', 'abandoned']),
    hostName: z.string(),
    venueName: z.string().optional(),
    createdAt: z.iso.datetime(),
    itemCount: z.int().min(0),
    totalPence: z.int().min(0),
    people: z.array(z.string()),
  })
  .meta({ id: 'SessionPreview' });

// The one way a guest pays today. Its own component until the spec was
// generated; nothing referred to it but PaymentInstructions.
const manualTransfer = z.object({
  type: z.enum(['manual_transfer']),
  bankDetails: z
    .object({
      sortCode: z.string().regex(new RegExp('^[0-9]{6}$')),
      accountNumber: z.string().regex(new RegExp('^[0-9]{8}$')),
      accountHolderName: z.string(),
    })
    .meta({
      description:
        "The collector's bank details, when stored server-side. Omitted when they only live on the lead's device (ADR-0002); clients then use the details from the join QR fragment.",
    })
    .optional(),
  reference: z.string().meta({
    description:
      "What the guest puts on their bank transfer: the venue and their first name ('Gennaro Tom'), letters, digits and spaces, at most 18 characters",
  }),
  amountPence: z.int().min(1),
  links: z
    .object({
      monzo: z
        .url()
        .meta({ example: 'https://monzo.me/callum.davies/12.34?d=gdp-019e137a' })
        .optional(),
      revolut: z.url().meta({ example: 'https://revolut.me/callumd/12.34' }).optional(),
    })
    .meta({
      description:
        'One-tap deep links into popular banking apps; populated only if the lead has the matching handle saved on `payoutAccount`.',
    }),
});

export const PaymentInstructions = manualTransfer.meta({
  id: 'PaymentInstructions',
  description: `How the guest pays: the bank details and reference to use in their own banking app,
plus optional Monzo/Revolut links. The lead then confirms receipt via
\`POST /v1/payments/{paymentId}/confirm\`.
`,
});

export const InitiatePaymentResponse = z
  .object({
    payment: Payment,
    instructions: PaymentInstructions,
  })
  .meta({ id: 'InitiatePaymentResponse' });
