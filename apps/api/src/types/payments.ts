import { z } from 'zod';

export const PaymentStatusSchema = z.enum(['pending', 'succeeded', 'failed']);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PaymentEventSourceSchema = z.enum(['api', 'system']);

export const PaymentEventSchema = z.object({
  at: z.string().datetime(),
  from: PaymentStatusSchema,
  to: PaymentStatusSchema,
  source: PaymentEventSourceSchema,
  note: z.string().optional(),
});
export type PaymentEvent = z.infer<typeof PaymentEventSchema>;

export const PaymentSchema = z.object({
  paymentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  payerUserId: z.string(),
  collectorUserId: z.string(),
  amountPence: z.number().int().positive(),
  currency: z.literal('GBP'),
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

// How a guest pays the lead: from their own banking app, with these
// details and reference; the lead confirms the money arrived.
export const ManualTransferInstructionsSchema = z.object({
  type: z.literal('manual_transfer'),
  // Absent when the lead's bank details only live on their device
  // (ADR-0002) — the client uses the ones from the join QR instead.
  bankDetails: z
    .object({
      sortCode: z.string(),
      accountNumber: z.string(),
      accountHolderName: z.string(),
    })
    .optional(),
  reference: z.string(),
  amountPence: z.number().int().positive(),
  links: z.object({
    monzo: z.string().url().optional(),
    revolut: z.string().url().optional(),
  }),
});
export type ManualTransferInstructions = z.infer<typeof ManualTransferInstructionsSchema>;

export const PaymentInstructionsSchema = ManualTransferInstructionsSchema;
export type PaymentInstructions = z.infer<typeof PaymentInstructionsSchema>;

export const InitiatePaymentResponseSchema = z.object({
  payment: PaymentSchema,
  instructions: PaymentInstructionsSchema,
});
export type InitiatePaymentResponse = z.infer<typeof InitiatePaymentResponseSchema>;
