import { z } from 'zod';

// Sign-in request bodies. openapi.yaml documents them from these.

/** An email to send a code to; also the test and dev sign-ins. */
export const EmailStartRequestSchema = z.object({
  email: z.string().email().max(254),
});

export const EmailVerifyRequestSchema = z.object({
  requestId: z.string().min(1).max(200),
  code: z.string().regex(/^[0-9]{6}$/),
});

export const PhoneStartRequestSchema = z.object({
  phone: z.string().min(6).max(24).meta({ description: 'As typed, e.g. "07700 900123".' }),
  // Texts are the only way (WhatsApp dropped); older pages still send it.
  channel: z
    .literal('sms')
    .optional()
    .meta({ description: 'Optional; texts are the only channel.' }),
});

export const PhoneVerifyRequestSchema = z.object({
  requestId: z.string().min(1).max(200),
  code: z.string().regex(/^[0-9]{4}$/),
});
