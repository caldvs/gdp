import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { AppError } from '../errors/AppError.js';
import { createEmailOtpService } from '../services/auth/emailOtp.js';
import type { EmailSender } from '../services/email/sender.js';

const StartSchema = z.object({
  email: z.string().email().max(254),
});

const VerifySchema = z.object({
  email: z.string().email().max(254),
  code: z.string().regex(/^[0-9]{6}$/, 'code must be 6 digits'),
});

export interface AuthRoutesDeps {
  emailSender: EmailSender;
  jwtSecret: Uint8Array;
}

export const buildAuthRoutes = (deps: AuthRoutesDeps): Hono => {
  const r = new Hono();
  const otpService = createEmailOtpService({
    emailSender: deps.emailSender,
    jwtSecret: deps.jwtSecret,
  });

  r.post(
    '/email/start',
    zValidator('json', StartSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'INVALID_INPUT' as const,
              message: 'Invalid email',
              requestId: c.var.requestId,
            },
          },
          400,
        );
      }
    }),
    async (c) => {
      const { email } = c.req.valid('json');
      try {
        await otpService.start({ email });
      } catch (err) {
        // Email delivery failures should still produce the uniform
        // success response — we don't want to leak whether SES bounced
        // a particular address. Log + 200.
        if (!(err instanceof AppError)) {
          c.var.logger.error({ event: 'otp.start.failed', email, err }, 'OTP delivery failed');
        } else {
          throw err;
        }
      }
      return c.json({ ok: true });
    },
  );

  r.post(
    '/email/verify',
    zValidator('json', VerifySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'INVALID_INPUT' as const,
              message: 'Invalid email or code',
              requestId: c.var.requestId,
            },
          },
          400,
        );
      }
    }),
    async (c) => {
      const { email, code } = c.req.valid('json');
      const result = await otpService.verify({ email, code });
      return c.json(result);
    },
  );

  return r;
};
