import { z } from 'zod';
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

export const ParticipantSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().url().optional(),
  claimedItemIds: z.array(z.string().uuid()),
  // Items the participant is *sharing* with other diners (ADR-0006).
  // Distinct from claimedItemIds: a share is one unit divided across the
  // sharers, not a per-unit claim. Items may only appear in one of the
  // two lists session-wide (v1 simplification). Default [].
  sharedItemIds: z.array(z.string().uuid()).default([]),
  owedPence: z.number().int().nonnegative().optional(),
  payment: ParticipantPaymentSchema,
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

// POST /v1/sessions/:id/shares body — caller joins the splitter set
// for a single item (ADR-0006). `ways` is how many people shared the
// item; it is only read when the caller *starts* the split (nobody else
// in it yet). Joining an existing split ignores it.
export const AddShareRequestSchema = z.object({
  itemId: z.string().uuid(),
  ways: WaysSchema.optional(),
});
export type AddShareRequest = z.infer<typeof AddShareRequestSchema>;

// PUT /v1/sessions/:id/shares/:itemId body — someone in the split
// changes how many ways it is divided.
export const SetShareWaysRequestSchema = z.object({ ways: WaysSchema });
export type SetShareWaysRequest = z.infer<typeof SetShareWaysRequestSchema>;

// Recent changes to a split, so the people in it can see what others did.
export const ShareActivitySchema = z.object({
  kind: z.enum(['started', 'joined', 'left', 'ways']),
  byUserId: z.string(),
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
  version: z.number().int().min(1),
  activity: z.array(ShareActivitySchema),
});
export type ShareSettings = z.infer<typeof ShareSettingsSchema>;
export const SHARE_ACTIVITY_KEEP = 10;

export const SessionSchema = z.object({
  sessionId: z.string().uuid(),
  status: SessionStatusSchema,
  creatorUserId: z.string(),
  collectorUserId: z.string(),
  billId: z.string().uuid(),
  pinnedBillVersion: z.number().int().min(1),
  joinCode: z
    .string()
    .regex(/^[A-HJ-NP-Z2-9]{6}$/)
    .optional(),
  participants: z.array(ParticipantSchema),
  // Denormalised from the pinned bill at session-create time so the
  // frontend can render a venue strapline without a second round-trip.
  // Optional both because old sessions predate this field and because
  // not every bill has a venue Gemini could extract.
  venue: VenueSchema.optional(),
  // Computed at read time from participants' sharedItemIds (ADR-0006).
  // One entry per shared item; userIds is the splitter set. Empty when
  // no items are shared. Server-only — clients never set this.
  //
  // `ways` is how many people the item is divided between (fixed by
  // whoever started the split, changeable by anyone in it). Each sharer
  // owes unitPrice / ways; spots nobody has taken yet are unclaimed.
  shares: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        userIds: z.array(z.string()),
        ways: z.number().int().min(1),
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
});
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const JoinByCodeRequestSchema = z.object({
  code: z.string().regex(/^[A-HJ-NP-Z2-9]{6}$/),
});
export type JoinByCodeRequest = z.infer<typeof JoinByCodeRequestSchema>;

export const ClaimsRequestSchema = z.object({
  claimedItemIds: z.array(z.string().uuid()),
});
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
  joinCode: z
    .string()
    .regex(/^[A-HJ-NP-Z2-9]{6}$/)
    .optional(),
  venue: z.object({ name: z.string() }).optional(),
  createdAt: z.string().datetime(),
  role: z.enum(['lead', 'diner']),
  myOwedPence: z.number().int().nonnegative().optional(),
  myPaymentStatus: z.enum(['unpaid', 'self_paid', 'pending', 'succeeded', 'failed']),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;
