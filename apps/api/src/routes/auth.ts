import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createEmailSignInService } from '../services/auth/emailSignIn.js';
import type { EmailSender } from '../services/email/sender.js';
import { pickLinkBase } from '../config/allowedOrigins.js';

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

const LinkTokenSchema = z.object({
  token: z.string().min(1).max(200),
});

const LinkSchema = LinkTokenSchema.extend({
  /** The number the person confirmed matches the asking tab's (#138). */
  code: z.string().regex(/^[0-9]{2}$/),
});

const RequestSchema = z.object({
  requestId: z.string().min(1).max(200),
});

export interface AuthRoutesDeps {
  emailSender: EmailSender;
  jwtSecret: Uint8Array;
  /** The web app's address, for sign-in links (APP_BASE_URL). */
  appBaseUrl: string;
  /**
   * Exact bases a sign-in link may point back to instead, when the request's
   * Origin is one of them character for character (#149). Empty in prod and
   * locally: links use appBaseUrl.
   */
  linkBases: readonly string[];
  /**
   * Register POST /email/dev-sign-in (sign in with just an email).
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
      // Exempt addresses get a session straight away, no link.
      const signedIn = await signIn.exemptSignIn({ email });
      if (signedIn) return c.json({ ok: true, ...signedIn });
      const appBaseUrl = pickLinkBase(c.req.header('origin'), deps.linkBases, deps.appBaseUrl);
      const sourceIp = sourceIpOf(c.env);
      const { requestId, code, send } = await signIn.start({
        email,
        appBaseUrl,
        ...(sourceIp ? { sourceIp } : {}),
      });
      try {
        await send();
      } catch (err) {
        // Email delivery failures still get the uniform response — we
        // don't want to leak whether SES bounced a particular address.
        c.var.logger.error({ event: 'signin.start.failed', err }, 'Link delivery failed');
      }
      return c.json({ ok: true, requestId, code });
    },
  );

  const invalidLink = zValidator('json', LinkTokenSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'INVALID_INPUT' as const,
            message: 'Invalid link',
            requestId: c.var.requestId,
          },
        },
        400,
      );
    }
  });

  // The link's page asks for the number to show before going on (#138).
  r.post('/email/link/code', invalidLink, async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(await signIn.peekLink({ token: c.req.valid('json').token }));
  });

  // "That's not my number": nobody is signed in by this request.
  r.post('/email/link/deny', invalidLink, async (c) => {
    await signIn.denyLink({ token: c.req.valid('json').token });
    return c.json({ ok: true });
  });

  r.post(
    '/email/link',
    zValidator('json', LinkSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'INVALID_INPUT' as const,
              message: 'Invalid link',
              requestId: c.var.requestId,
            },
          },
          400,
        );
      }
    }),
    async (c) => {
      const { token, code } = c.req.valid('json');
      return c.json(await signIn.openLink({ token, code }));
    },
  );

  // The tab that asked, waiting for the link to be opened. POST, so its
  // secret requestId stays in the body and out of request logs.
  r.post(
    '/email/requests',
    zValidator('json', RequestSchema, (result, c) => {
      if (!result.success) {
        return c.json(
          {
            error: {
              code: 'INVALID_INPUT' as const,
              message: 'Invalid request',
              requestId: c.var.requestId,
            },
          },
          400,
        );
      }
    }),
    async (c) => {
      c.header('cache-control', 'no-store');
      return c.json(await signIn.requestStatus({ requestId: c.req.valid('json').requestId }));
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
