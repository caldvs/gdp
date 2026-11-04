import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { createEmailSignInService } from '../services/auth/emailSignIn.js';
import type { EmailSender } from '../services/email/sender.js';

const StartSchema = z.object({
  email: z.string().email().max(254),
});

const LinkSchema = z.object({
  token: z.string().min(1).max(200),
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
   * Origins a sign-in link may point back to instead (the CORS allow-list),
   * so someone signing in on test.paymeback.dev or a preview is sent back
   * there. Null when there's no list (local): links use appBaseUrl.
   */
  linkOriginAllowed: ((origin: string) => boolean) | null;
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
      const origin = c.req.header('origin');
      const appBaseUrl = origin && deps.linkOriginAllowed?.(origin) ? origin : deps.appBaseUrl;
      const { requestId, send } = await signIn.start({ email, appBaseUrl });
      try {
        await send();
      } catch (err) {
        // Email delivery failures still get the uniform response — we
        // don't want to leak whether SES bounced a particular address.
        c.var.logger.error({ event: 'signin.start.failed', email, err }, 'Link delivery failed');
      }
      return c.json({ ok: true, requestId });
    },
  );

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
      const { token } = c.req.valid('json');
      return c.json(await signIn.openLink({ token }));
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
