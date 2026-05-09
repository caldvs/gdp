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

export const PaymentSchema = z.object({
  paymentId: z.string().uuid(),
  sessionId: z.string().uuid(),
  payerUserId: z.string(),
  collectorUserId: z.string(),
  amountPence: z.number().int().positive(),
  currency: z.literal('GBP'),
  provider: z.enum(['truelayer', 'mock']),
  providerPaymentId: z.string(),
  status: PaymentStatusSchema,
  idempotencyKey: z.string(),
  events: z.array(PaymentEventSchema),
  createdAt: z.string().datetime(),
});
export type Payment = z.infer<typeof PaymentSchema>;

export const InitiatePaymentResponseSchema = z.object({
  payment: PaymentSchema,
  providerRedirectUrl: z.string().url(),
});
export type InitiatePaymentResponse = z.infer<typeof InitiatePaymentResponseSchema>;
