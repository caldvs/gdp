/**
 * Contract check for the integration suite: every response the API sends
 * in a test is checked against openapi.yaml. A status the spec doesn't
 * list for that operation, or a JSON body that doesn't match the listed
 * schema, fails the test that made the request.
 *
 * Installed by `contract-setup.ts` (a Vitest setup file), which wraps
 * Hono's `app.request`, so every test is covered without changing it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { parse } from 'yaml';

type Json = Record<string, unknown>;
type Operation = { responses?: Record<string, Json> };
type Route = { template: string; regex: RegExp; methods: Record<string, Operation> };

const here = dirname(fileURLToPath(import.meta.url));
const spec = parse(readFileSync(join(here, '../../openapi.yaml'), 'utf8')) as Json;
const SPEC_ID = 'openapi.json';

// Routes that exist on purpose without being part of the public contract.
const UNDOCUMENTED = new Set([
  'POST /v1/auth/email/dev-sign-in', // local and test only
  'GET /docs',
  'GET /swagger',
  'GET /openapi.yaml',
]);

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;
const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false });
addFormats(ajv);
ajv.addSchema(spec, SPEC_ID);

const escape = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');

const routes: Route[] = Object.entries(spec.paths as Record<string, Json>).map(
  ([template, item]) => {
    const pattern = template
      .split('/')
      .map((seg) => (/^\{.+\}$/.test(seg) ? '[^/]+' : seg.replace(/[.*+?^$()|[\]\\]/g, '\\$&')))
      .join('/');
    const methods: Record<string, Operation> = {};
    for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
      if (item[m]) methods[m] = item[m];
    }
    return { template, regex: new RegExp(`^${pattern}$`), methods };
  },
);

// Prefer the most literal match: /v1/sessions/by-code over /v1/sessions/{sessionId}.
const literalness = (t: string) => t.split('/').filter((s) => !s.startsWith('{')).length;
routes.sort((a, b) => literalness(b.template) - literalness(a.template));

const validators = new Map<string, ValidateFunction>();

/** Follow a `$ref: '#/components/responses/X'` to its response object and JSON pointer. */
function resolveResponse(pointer: string, response: Json): { pointer: string; response: Json } {
  const ref = response.$ref;
  if (typeof ref !== 'string') return { pointer, response };
  const target = ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>(
      (node, key) => (node as Json)[key.replace(/~1/g, '/').replace(/~0/g, '~')],
      spec,
    );
  return { pointer: ref.replace(/^#/, ''), response: target as Json };
}

export type Violation = string;

/**
 * Check one response. Returns a description of what's wrong, or null.
 * Non-JSON bodies are checked only for the status.
 */
export async function checkResponse(
  method: string,
  url: string,
  res: Response,
): Promise<Violation | null> {
  const path = new URL(url, 'http://test.local').pathname;
  const m = method.toLowerCase();
  const key = `${method.toUpperCase()} ${path}`;
  if (UNDOCUMENTED.has(key)) return null;

  const route = routes.find((r) => r.regex.test(path));
  if (!route) return `${key}: no such path in openapi.yaml`;
  const op = route.methods[m];
  if (!op) return `${key}: ${m.toUpperCase()} isn't documented for ${route.template}`;

  const status = String(res.status);
  const responses = op.responses ?? {};
  const listed =
    responses[status] !== undefined ? status : responses.default !== undefined ? 'default' : null;
  if (!listed) {
    let code = '';
    try {
      code = ` (${((await res.clone().json()) as { error?: { code?: string } }).error?.code ?? ''})`;
    } catch {
      // not JSON
    }
    return `${key}: status ${status}${code} isn't listed for ${m.toUpperCase()} ${route.template} (has ${Object.keys(responses).join(', ')})`;
  }

  const base = `/paths/${escape(route.template)}/${m}/responses/${escape(listed)}`;
  const { pointer, response } = resolveResponse(base, responses[listed]!);
  const content = response.content as Record<string, Json> | undefined;
  const contentType = res.headers.get('content-type') ?? '';
  if (!content?.['application/json'] || !contentType.includes('application/json')) return null;

  const schemaPointer = `${pointer}/content/application~1json/schema`;
  let validate = validators.get(schemaPointer);
  if (!validate) {
    validate = ajv.compile({ $ref: `${SPEC_ID}#${schemaPointer}` });
    validators.set(schemaPointer, validate);
  }
  const text = await res.clone().text();
  if (!text) return `${key} → ${status}: empty body, schema expected`;
  const body: unknown = JSON.parse(text);
  if (validate(body)) return null;
  const errors = (validate.errors ?? [])
    .slice(0, 5)
    .map((e) => `${e.instancePath || '(body)'} ${e.message ?? ''}`)
    .join('; ');
  return `${key} → ${status}: body doesn't match ${route.template} ${listed}: ${errors}`;
}
