import { z } from 'zod';

export const PaymentStatusSchema = z.enum([
  'pending',
  'authorized',
  'succeeded',
  'failed',
  'refunded',
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PaymentEventSourceSchema = z.enum(['api', 'webhook', 'system']);

export const PaymentEventSchema = z.object({
  at: z.string().datetime(),
  from: PaymentStatusSchema,
  to: PaymentStatusSchema,
  source: PaymentEventSourceSchema,
  note: z.string().optional(),
});
export type PaymentEvent = z.infer<typeof PaymentEventSchema>;

export const PaymentProviderNameSchema = z.enum(['truelayer', 'manual']);
export type PaymentProviderName = z.infer<typeof PaymentProviderNameSchema>;

export const PaymentSchema = z.object({
  paymentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  payerUserId: z.string(),
  collectorUserId: z.string(),
  amountPence: z.number().int().positive(),
  currency: z.literal('GBP'),
  provider: PaymentProviderNameSchema,
  providerPaymentId: z.string(),
  status: PaymentStatusSchema,
  idempotencyKey: z.string(),
  events: z.array(PaymentEventSchema),
  createdAt: z.string().datetime(),
  /**
   * Set when the payer hits POST /v1/payments/:id/mark-paid to claim
   * "I've sent the money via my bank". Surfaced in the lead's UI so they
   * know which pending payments are awaiting their confirmation. Does not
   * itself advance status — only the lead's /confirm does that.
   */
  payerClaimedPaidAt: z.string().datetime().optional(),
});
export type Payment = z.infer<typeof PaymentSchema>;

// Frontend-facing instructions for completing a guest payment. Discriminated
// on `type` so the mobile app can switch UI:
// - `redirect`: open the URL (TrueLayer hosted page); webhook drives state
// - `manual_transfer`: render bank details + optional Monzo/Revolut links;
//   guest pays via their own banking app, lead confirms receipt manually
export const ManualTransferInstructionsSchema = z.object({
  type: z.literal('manual_transfer'),
  bankDetails: z.object({
    sortCode: z.string(),
    accountNumber: z.string(),
    accountHolderName: z.string(),
  }),
  reference: z.string(),
  amountPence: z.number().int().positive(),
  links: z.object({
    monzo: z.string().url().optional(),
    revolut: z.string().url().optional(),
  }),
});
export type ManualTransferInstructions = z.infer<typeof ManualTransferInstructionsSchema>;

export const RedirectInstructionsSchema = z.object({
  type: z.literal('redirect'),
  url: z.string().url(),
});
export type RedirectInstructions = z.infer<typeof RedirectInstructionsSchema>;

export const PaymentInstructionsSchema = z.discriminatedUnion('type', [
  ManualTransferInstructionsSchema,
  RedirectInstructionsSchema,
]);
export type PaymentInstructions = z.infer<typeof PaymentInstructionsSchema>;

export const InitiatePaymentResponseSchema = z.object({
  payment: PaymentSchema,
  instructions: PaymentInstructionsSchema,
});
export type InitiatePaymentResponse = z.infer<typeof InitiatePaymentResponseSchema>;
