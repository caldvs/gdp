import { z } from 'zod';

// UK sort code (6 digits) and account number (8 digits). Strict format —
// validation rejects spaces, hyphens, or alternative separators; the
// frontend should normalise before submitting.
//
// monzoHandle / revolutTag are OPTIONAL one-tap-pay handles that get
// rendered as monzo.me / revolut.me deep links when a guest is paying;
// guests on other banks still get the sort+account+name to type into
// their own banking app.
export const PayoutAccountSchema = z
  .object({
    sortCode: z
      .string()
      .regex(/^\d{6}$/, 'sortCode must be 6 digits')
      .meta({ description: 'UK sort code, 6 digits, no separators', example: '040668' }),
    accountNumber: z
      .string()
      .regex(/^\d{8}$/, 'accountNumber must be 8 digits')
      .meta({ description: 'UK account number, 8 digits', example: '00079660' }),
    accountHolderName: z.string().trim().min(1).max(150).meta({ example: 'Callum Davies' }),
    monzoHandle: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,30}$/, 'monzoHandle: 1-30 chars, alphanumerics + . _ -')
      .optional()
      .meta({
        description:
          'Optional monzo.me username (without the leading `@` or domain). When set, guest payment instructions include a one-tap `https://monzo.me/<handle>/...` link.',
        example: 'callum.davies',
      }),
    revolutTag: z
      .string()
      .regex(/^[a-z0-9]{1,32}$/i, 'revolutTag: 1-32 alphanumerics')
      .optional()
      .meta({
        description:
          'Optional Revolut tag (without the leading `@`). When set, guest payment instructions include a one-tap `https://revolut.me/<tag>/...` link.',
        example: 'callumd',
        // The regex is case-insensitive; JSON Schema patterns have no flags.
        pattern: '^[a-zA-Z0-9]{1,32}$',
      }),
  })
  .meta({
    id: 'PayoutAccount',
    description:
      "A UK bank account. Per ADR-0002 it lives on the lead's device and travels in the join link's fragment; the server never stores it.",
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
  // Bumped by signing out everywhere (#155): session tokens minted with an
  // older version stop working. Absent is 0.
  tokenVersion: z.number().int().nonnegative().optional(),
});
export type User = z.infer<typeof UserSchema>;

// Request body for PUT /v1/me/payout-account.
export const SetPayoutAccountRequestSchema = PayoutAccountSchema;
export type SetPayoutAccountRequest = z.infer<typeof SetPayoutAccountRequestSchema>;

// PATCH /v1/me body.
export const ProfilePatchSchema = z
  .object({
    displayName: z.string().trim().min(1).max(40).optional(),
    /** Where bill emails go (#213). Not used to sign in; '' removes it. */
    email: z.union([z.string().trim().email().max(254), z.literal('')]).optional(),
  })
  .strict();
