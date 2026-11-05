import { z } from 'zod';
import { JOIN_CODE } from '../services/sessions/joinCode.js';
import { VenueSchema } from './bills.js';

export const SessionStatusSchema = z.enum(['setup', 'claiming', 'paying', 'settled', 'abandoned']);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const ParticipantPaymentSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unpaid') }),
  z.object({ status: z.literal('self_paid') }),
  z.object({
    status: z.literal('pending'),
    paymentId: z.string().uuid(),
    /** Mirrors Payment.payerClaimedPaidAt; surfaced here so the lead's
     * session view can flag "they say they've paid, awaiting your confirm". */
    payerClaimedPaidAt: z.string().datetime().optional(),
  }),
  z.object({
    status: z.literal('succeeded'),
    paymentId: z.string().uuid(),
    paidAt: z.string().datetime(),
  }),
  z.object({
    status: z.literal('failed'),
    paymentId: z.string().uuid(),
    reason: z.string(),
  }),
]);
export type ParticipantPayment = z.infer<typeof ParticipantPaymentSchema>;

// One payment a guest has made to the lead (#121): a guest can pay more
// than once, topping up after claiming more. Mirrors the Payment row.
export const ParticipantPaymentEntrySchema = z.object({
  paymentId: z.string().uuid(),
  amountPence: z.number().int().nonnegative(),
  status: z.enum(['pending', 'succeeded', 'failed']),
  payerClaimedPaidAt: z.string().datetime().optional(),
  paidAt: z.string().datetime().optional(),
  reason: z.string().optional(),
});
export type ParticipantPaymentEntry = z.infer<typeof ParticipantPaymentEntrySchema>;

export const ParticipantSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().url().optional(),
  claimedItemIds: z.array(z.string().uuid()),
  // Items the participant is *sharing* with other diners (ADR-0006).
  // Distinct from claimedItemIds: a share is `units` of the line divided
  // across the sharers, not a per-unit claim. On a quantity-1 line an item
  // is either claimed or shared; on a longer line the rest of it can still
  // be claimed one at a time. Default [].
  sharedItemIds: z.array(z.string().uuid()).default([]),
  owedPence: z.number().int().nonnegative().optional(),
  // The latest state across `payments` (in flight if any is), kept for
  // everything that only needs "has this guest paid".
  payment: ParticipantPaymentSchema,
  // Every payment this guest has made, oldest first (#121). Absent on
  // sessions from before top-ups (then `payment` is the only one).
  payments: z.array(ParticipantPaymentEntrySchema).optional(),
  // True once the diner has signalled they're done claiming. Lock-claims
  // requires all non-creator participants to be ready (unless force=true).
  // Default false; flipped via POST /v1/sessions/:id/ready.
  readyToLock: z.boolean().default(false),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const SetReadyRequestSchema = z.object({
  ready: z.boolean(),
});
export type SetReadyRequest = z.infer<typeof SetReadyRequestSchema>;

export const LockClaimsRequestSchema = z.object({
  // Bypass the all-ready precondition. Useful if a guest has dropped off.
  force: z.boolean().optional(),
});
export type LockClaimsRequest = z.infer<typeof LockClaimsRequestSchema>;

// How many ways a shared item can be split.
export const SHARE_WAYS_MIN = 2;
export const SHARE_WAYS_MAX = 20;
const WaysSchema = z.number().int().min(SHARE_WAYS_MIN).max(SHARE_WAYS_MAX);
// How many of a line one split covers (2 bottles of wine shared by 4).
export const SHARE_UNITS_MAX = 999;
const UnitsSchema = z.number().int().min(1).max(SHARE_UNITS_MAX);

// POST /v1/sessions/:id/shares body — caller joins the splitter set
// for a single item (ADR-0006). `ways` is how many people shared the
// item; it is only read when the caller *starts* the split (nobody else
// in it yet). Joining an existing split ignores it. `units` is how many of
// a multi-quantity line the split covers, also read only when starting it;
// it defaults to every unit nobody has claimed.
export const AddShareRequestSchema = z.object({
  itemId: z.string().uuid(),
  ways: WaysSchema.optional(),
  units: UnitsSchema.optional(),
});
export type AddShareRequest = z.infer<typeof AddShareRequestSchema>;

// PUT /v1/sessions/:id/shares/:itemId body — someone in the split
// changes how many ways it is divided.
export const SetShareWaysRequestSchema = z.object({ ways: WaysSchema });
export type SetShareWaysRequest = z.infer<typeof SetShareWaysRequestSchema>;

// Recent changes to a split, so the people in it can see what others did.
export const ShareActivitySchema = z.object({
  // 'split': byUserId split an item fromUserId had claimed (#130).
  kind: z.enum(['started', 'joined', 'left', 'ways', 'split']),
  byUserId: z.string(),
  fromUserId: z.string().optional(),
  at: z.string().datetime(),
  fromWays: z.number().int().optional(),
  toWays: z.number().int().optional(),
});
export type ShareActivity = z.infer<typeof ShareActivitySchema>;

// Stored per shared item (its own row, so concurrent edits to different
// splits never collide). `version` guards read-modify-write.
export const ShareSettingsSchema = z.object({
  itemId: z.string().uuid(),
  ways: WaysSchema,
  // How many of the line the split covers. Absent on splits from before
  // multi-quantity splits, which always covered one.
  units: UnitsSchema.optional(),
  // Who is in the split, copied from the participant rows (their
  // sharedItemIds are the truth) in the same write, so GET /v1/me/sessions
  // can work out a sharer's part without reading every participant.
  // Absent on splits from before 5 Nov 2026.
  userIds: z.array(z.string()).optional(),
  version: z.number().int().min(1),
  activity: z.array(ShareActivitySchema),
});
export type ShareSettings = z.infer<typeof ShareSettingsSchema>;
export const SHARE_ACTIVITY_KEEP = 10;

// How many people the lead said are eating, the lead included (#64).
// Only shown as progress ("3 of 4 joined"); never used in the money maths.
export const EXPECTED_DINERS_MIN = 2;
export const EXPECTED_DINERS_MAX = 99;
const ExpectedDinersSchema = z.number().int().min(EXPECTED_DINERS_MIN).max(EXPECTED_DINERS_MAX);

export const SessionSchema = z.object({
  sessionId: z.string().uuid(),
  status: SessionStatusSchema,
  creatorUserId: z.string(),
  collectorUserId: z.string(),
  billId: z.string().uuid(),
  pinnedBillVersion: z.number().int().min(1),
  joinCode: z.string().regex(JOIN_CODE).optional(),
  participants: z.array(ParticipantSchema),
  // Denormalised from the pinned bill at session-create time so the
  // frontend can render a venue strapline without a second round-trip.
  // Optional both because old sessions predate this field and because
  // not every bill has a venue the reader could extract.
  venue: VenueSchema.optional(),
  // How many people the lead expects at the table, lead included. Unset
  // until the lead says.
  expectedDiners: ExpectedDinersSchema.optional(),
  // The hold that paid for the share (#165), which the guests pay back in
  // proportion to what they ordered (#166). Absent when a credit, an exempt
  // lead or Stripe being off paid for it.
  platformFeePence: z.number().int().nonnegative().optional(),
  // The lead's device's fingerprint of the bank details it puts in the join
  // link (#151): PBKDF2 of the details salted with the session id, never the
  // details themselves (ADR-0002). Guests' apps check the link against it.
  payoutCheck: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  // Computed at read time from participants' sharedItemIds (ADR-0006).
  // One entry per shared item; userIds is the splitter set. Empty when
  // no items are shared. Server-only — clients never set this.
  //
  // `ways` is how many people the item is divided between (fixed by
  // whoever started the split, changeable by anyone in it). `units` is how
  // many of the line it covers. Each sharer owes unitPrice × units / ways;
  // spots nobody has taken yet are unclaimed.
  shares: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        userIds: z.array(z.string()),
        ways: z.number().int().min(1),
        units: z.number().int().min(1),
        activity: z.array(ShareActivitySchema),
      }),
    )
    .optional(),
  // Storage-side split settings. Server-only: merged into `shares` and
  // stripped before a session is returned.
  shareSettings: z.array(ShareSettingsSchema).optional(),
  createdAt: z.string().datetime(),
  ttlAt: z.string().datetime().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

// ---- Request bodies ----

export const CreateSessionRequestSchema = z.object({
  billId: z.string().uuid(),
  billVersion: z.number().int().min(1).optional(),
  expectedDiners: ExpectedDinersSchema.optional(),
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

// PATCH /v1/sessions/:id body — the lead changes how many are eating;
// null clears it.
export const UpdateSessionRequestSchema = z
  .object({ expectedDiners: ExpectedDinersSchema.nullable() })
  .strict();
export type UpdateSessionRequest = z.infer<typeof UpdateSessionRequestSchema>;

export const JoinByCodeRequestSchema = z.object({
  code: z.string().regex(JOIN_CODE),
});
export type JoinByCodeRequest = z.infer<typeof JoinByCodeRequestSchema>;

/** A guest joining with just a name (#183). */
export const GuestJoinRequestSchema = z.object({
  code: z.string().regex(JOIN_CODE),
  name: z
    .string()
    .trim()
    .min(1)
    .max(40)
    // No markup or control characters: it's shown to everyone at the table.
    .refine((n) => !/[<>]/.test(n) && [...n].every((ch) => ch.charCodeAt(0) >= 32), 'Not a name'),
});
export type GuestJoinRequest = z.infer<typeof GuestJoinRequestSchema>;

/** What the QR's landing page shows before anyone joins (#183). No bank details (ADR-0002). */
export interface SessionPreview {
  sessionId: string;
  status: 'setup' | 'claiming' | 'paying' | 'settled' | 'abandoned';
  hostName: string;
  venueName?: string;
  createdAt: string;
  itemCount: number;
  totalPence: number;
  /** First names of everyone at the table, host first. */
  people: string[];
}

export const ClaimsRequestSchema = z.object({
  // A bill has at most 200 lines (AMEND_LIMITS, #155).
  claimedItemIds: z.array(z.string().uuid()).max(200),
});

// PUT /v1/sessions/:id/payout-check body (#151): the lead's device's
// fingerprint of the bank details it puts in the join link. Never the
// details themselves (ADR-0002).
export const SetPayoutCheckRequestSchema = z
  .object({ payoutCheck: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();
export type ClaimsRequest = z.infer<typeof ClaimsRequestSchema>;

// Lightweight session summary returned by GET /v1/me/sessions. Distinct from
// `Session` because it doesn't include the full participants list — just the
// caller's role, share, and payment status.
//
// `venue` is intentionally a slim projection of the bill's Venue with just
// `name` — enough for a list-view strapline. The full Venue (placeId, lat,
// lng, address) is on GET /v1/sessions/{id}.
export const SessionSummarySchema = z.object({
  sessionId: z.string().uuid(),
  status: SessionStatusSchema,
  creatorUserId: z.string(),
  collectorUserId: z.string(),
  billId: z.string().uuid(),
  pinnedBillVersion: z.number().int().min(1),
  joinCode: z.string().regex(JOIN_CODE).optional(),
  venue: z.object({ name: z.string() }).optional(),
  createdAt: z.string().datetime(),
  role: z.enum(['lead', 'diner']),
  myOwedPence: z.number().int().nonnegative().optional(),
  myPaymentStatus: z.enum(['unpaid', 'self_paid', 'pending', 'succeeded', 'failed']),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
