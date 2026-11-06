import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createEmailSignInService } from '../services/auth/emailSignIn.js';
import { createPhoneSignInService } from '../services/auth/phoneSignIn.js';
import type { SmsSender } from '../services/messaging/sms.js';
import { baseLogger } from '../logging/logger.js';
import type { EmailSender } from '../services/email/sender.js';

/**
 * The caller's IP address as API Gateway (HTTP API) saw it, for the per-IP
 * sign-in limit (#146). Undefined outside Lambda (local, tests).
 */
export const sourceIpOf = (env: unknown): string | undefined => {
  const ip = (env as { requestContext?: { http?: { sourceIp?: unknown } } } | undefined)
    ?.requestContext?.http?.sourceIp;
  return typeof ip === 'string' && ip ? ip : undefined;
};

const StartSchema = z.object({
  email: z.string().email().max(254),
});

const VerifySchema = z.object({
  requestId: z.string().min(1).max(200),
  code: z.string().regex(/^[0-9]{6}$/),
});

const PhoneStartSchema = z.object({
  phone: z.string().min(6).max(24),
  // Texts are the only way (WhatsApp dropped); older pages still send it.
  channel: z.literal('sms').optional(),
});

const PhoneVerifySchema = z.object({
  requestId: z.string().min(1).max(200),
  code: z.string().regex(/^[0-9]{4}$/),
});

export interface AuthRoutesDeps {
  emailSender: EmailSender;
  jwtSecret: Uint8Array;
  /** #231: sends phone codes by text; null or absent: no SMS. */
  phoneSms?: SmsSender | null;
  /**
   * Register POST /email/dev-sign-in (sign in with just an email, no code).
   * LOCAL DEVELOPMENT ONLY — set by src/local.ts, never by the Lambda.
   */
  devEmailSignIn?: boolean;
  /**
   * Register POST /email/test-sign-in (sign in to an @test.invalid account
   * with no code). Local and dev only: app.ts never sets it in prod.
   */
  testAccountSignIn?: boolean;
  /** Addresses that sign in from /email/start with no code. */
  exemptEmails?: ReadonlySet<string>;
}

export const buildAuthRoutes = (deps: AuthRoutesDeps): Hono => {
  const r = new Hono();
  const signIn = createEmailSignInService({
    emailSender: deps.emailSender,
    jwtSecret: deps.jwtSecret,
    ...(deps.exemptEmails ? { exemptEmails: deps.exemptEmails } : {}),
  });

  const phone = createPhoneSignInService({
    sms: deps.phoneSms ?? null,
    logger: baseLogger,
    jwtSecret: deps.jwtSecret,
  });

  // #213: which ways in are switched on here, so the web app offers only those.
  r.get('/methods', (c) => {
    const p = phone.available();
    return c.json({ email: true, phone: p.sms, sms: p.sms });
  });

  r.post(
    '/phone/start',
    zValidator('json', PhoneStartSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'INVALID_INPUT' as const,
              message: 'Enter a UK mobile number',
              requestId: c.var.requestId,
            },
          },
          400,
        );
      }
    }),
    async (c) => {
      const sourceIp = sourceIpOf(c.env);
      const out = await phone.start({ ...c.req.valid('json'), ...(sourceIp ? { sourceIp } : {}) });
      return c.json({ ok: true, requestId: out.requestId, phone: out.phone });
    },
  );

  r.post(
    '/phone/verify',
    zValidator('json', PhoneVerifySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'INVALID_INPUT' as const,
              message: 'Enter the 4-digit code',
              requestId: c.var.requestId,
            },
          },
          400,
        );
      }
    }),
    async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await phone.enterCode(c.req.valid('json')));
    },
  );

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
      // Exempt addresses get a session straight away, no code.
      const signedIn = await signIn.exemptSignIn({ email });
      if (signedIn) return c.json({ ok: true, ...signedIn });
      const sourceIp = sourceIpOf(c.env);
      const { requestId, send } = await signIn.start({
        email,
        ...(sourceIp ? { sourceIp } : {}),
      });
      try {
        await send();
      } catch (err) {
        // Email delivery failures still get the uniform response — we
        // don't want to leak whether SES bounced a particular address.
        c.var.logger.error({ event: 'signin.start.failed', err }, 'Code delivery failed');
      }
      return c.json({ ok: true, requestId });
    },
  );

  // The tab that asked enters the emailed code. POST, so its secret
  // requestId stays in the body and out of request logs.
  r.post(
    '/email/verify',
    zValidator('json', VerifySchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'INVALID_INPUT' as const,
              message: 'Enter the 6-digit code',
              requestId: c.var.requestId,
            },
          },
          400,
        );
      }
    }),
    async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await signIn.enterCode(c.req.valid('json')));
    },
  );

  if (deps.devEmailSignIn) {
    r.post(
      '/email/dev-sign-in',
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
        return c.json(await signIn.devSignIn({ email }));
      },
    );
  }

  if (deps.testAccountSignIn) {
    r.post(
      '/email/test-sign-in',
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
        return c.json(await signIn.testSignIn({ email }));
      },
    );
  }

  return r;
};
