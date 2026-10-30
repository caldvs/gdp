import { z } from 'zod';

// UK sort code (6 digits) and account number (8 digits). Strict format —
// validation rejects spaces, hyphens, or alternative separators; the
// frontend should normalise before submitting.
//
// monzoHandle / revolutTag are OPTIONAL one-tap-pay handles that get
// rendered as monzo.me / revolut.me deep links when a guest is paying;
// guests on other banks still get the sort+account+name to type into
// their own banking app.
export const PayoutAccountSchema = z.object({
  sortCode: z.string().regex(/^\d{6}$/, 'sortCode must be 6 digits'),
  accountNumber: z.string().regex(/^\d{8}$/, 'accountNumber must be 8 digits'),
  accountHolderName: z.string().trim().min(1).max(150),
  monzoHandle: z
    .string()
    .regex(/^[a-zA-Z0-9._-]{1,30}$/, 'monzoHandle: 1-30 chars, alphanumerics + . _ -')
    .optional(),
  revolutTag: z
    .string()
    .regex(/^[a-z0-9]{1,32}$/i, 'revolutTag: 1-32 alphanumerics')
    .optional(),
});
export type PayoutAccount = z.infer<typeof PayoutAccountSchema>;

export const UserSchema = z.object({
  userId: z.string(),
  displayName: z.string().optional(),
  email: z.string().email().optional(),
  avatarUrl: z.string().url().optional(),
  payoutAccount: PayoutAccountSchema.optional(),
  createdAt: z.string().datetime().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type User = z.infer<typeof UserSchema>;

// Request body for PUT /v1/me/payout-account.
export const SetPayoutAccountRequestSchema = PayoutAccountSchema;
export type SetPayoutAccountRequest = z.infer<typeof SetPayoutAccountRequestSchema>;
