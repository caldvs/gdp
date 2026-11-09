import { OpenAPIHono, type RouteConfig } from '@hono/zod-openapi';
import * as billing from './routes/billing.js';
import * as bills from './routes/bills.js';
import * as identity from './routes/identity.js';
import * as links from './routes/links.js';
import * as ops from './routes/ops.js';
import * as payments from './routes/payments.js';
import * as sessions from './routes/sessions.js';
import * as webhooks from './routes/webhooks.js';
import { sharedResponses } from './common.js';

/** Every route the API serves, by group, in the order the document lists them. */
export const routeGroups: Record<string, Record<string, RouteConfig>> = {
  ops,
  identity,
  bills,
  sessions,
  payments,
  links,
  billing,
  webhooks,
};

export const allRoutes = (): RouteConfig[] =>
  Object.values(routeGroups).flatMap((g) => Object.values(g));

const DESCRIPTION = `Backend for the Pay Me Back web app.

## Conventions

- **All money is integer pence (GBP).** No floats anywhere on the wire.
- **All identifiers are UUIDv7** unless documented otherwise.
- **Timestamps are RFC 3339** strings.
- **Auth** uses session JWTs issued by \`POST /v1/auth/email/verify\` (the emailed 6-digit code). Tokens are passed as \`Authorization: Bearer <jwt>\` and verified (signature + expiry) on every \`/v1/*\` request. The verified \`sub\` claim is the only userId the server trusts — any \`userId\` in a request body is ignored.
- **Errors** use a single envelope (\`ErrorResponse\`). \`error.code\` is the stable identifier; \`error.message\` is human-safe.
- **Idempotency** is required on every state-changing payment endpoint via the \`Idempotency-Key\` header. Same key + same body returns the cached response; same key + different body, or the same key while the first request is still running, returns \`409 IDEMPOTENCY_CONFLICT\`.
- **Versioning** is path-based (\`/v1/...\`). Multiple versions may run in parallel.
`;

/** The OpenAPI document: openapi.yaml is this, written out by `npm run gen:openapi`. */
export function openApiDocument() {
  const app = new OpenAPIHono();
  const registry = app.openAPIRegistry;
  registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description:
      'Session JWT minted by `/v1/auth/email/verify` (the emailed code). Verified server-side on every request.',
  });
  for (const [name, description] of Object.entries(sharedResponses)) {
    registry.registerComponent('responses', name, {
      description,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } },
    });
  }
  for (const route of allRoutes()) registry.registerPath(route);
  const doc = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: {
      title: 'Pay Me Back API',
      version: '0.1.0',
      // OpenAPI 3.1 has info.summary; the generator's 3.0 type doesn't.
      ...({ summary: 'Group restaurant bill splitting and Open Banking settlement.' } as object),
      description: DESCRIPTION,
      contact: { name: 'Pay Me Back' },
      license: { name: 'Proprietary' },
    },
    servers: [
      { url: 'https://api.gdp.example.com', description: 'production (placeholder until deploy)' },
      { url: 'http://localhost:3000', description: 'local development' },
    ],
    security: [{ bearerAuth: [] }],
    tags: [
      { name: 'identity', description: 'The authenticated caller' },
      { name: 'bills', description: 'Photographing, parsing, retrieving, and amending bills' },
      {
        name: 'sessions',
        description: 'Group dining sessions, the join flow, and claim management',
      },
      {
        name: 'payments',
        description: 'Guests paying the lead by bank transfer, confirmed by the lead',
      },
      { name: 'links', description: "The links in guests' texts (#219, #220); no sign-in" },
      { name: 'billing', description: "The lead's table fee, paid to Pay Me Back through Stripe" },
      { name: 'webhooks', description: 'Server-to-server callbacks (Stripe)' },
      { name: 'ops', description: 'Health and readiness probes' },
    ],
  });
  // Paths and components in name order, methods in the usual order: the
  // order they're met in depends on how modules happen to load (a module
  // namespace's keys are sorted under real ESM, not under tsx), and the file
  // shouldn't change with it.
  const byKey = <T>(o: Record<string, T>, rank = (k: string) => k) =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => rank(a).localeCompare(rank(b))));
  const METHODS = ['get', 'put', 'post', 'patch', 'delete'];
  const method = (k: string) => String(METHODS.indexOf(k) + 1 || 9) + k;
  doc.paths = byKey(
    Object.fromEntries(
      Object.entries(doc.paths ?? {}).map(([p, item]) => [
        p,
        byKey(item as Record<string, unknown>, method),
      ]),
    ),
  );
  doc.components = { ...doc.components, schemas: byKey(doc.components?.schemas ?? {}) };
  return doc;
}
