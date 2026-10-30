import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve openapi.yaml across runtime contexts:
 *   - tsx dev: src/routes/docs.ts → ../../openapi.yaml
 *   - bundled Lambda: dist/lambda.js → ./openapi.yaml (must be shipped
 *     alongside the bundle by the build / deploy step)
 *   - fallback: process.cwd()
 */
const SPEC_CANDIDATES = [
  join(here, '../../openapi.yaml'),
  join(here, 'openapi.yaml'),
  join(process.cwd(), 'openapi.yaml'),
];

let cachedSpec: string | null = null;
function loadSpec(): string {
  if (cachedSpec) return cachedSpec;
  for (const path of SPEC_CANDIDATES) {
    try {
      cachedSpec = readFileSync(path, 'utf-8');
      return cachedSpec;
    } catch {
      // try next candidate
    }
  }
  throw new Error('openapi.yaml not found in any expected location');
}

const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Group Dine Pay API</title>
    <style>body { margin: 0 }</style>
  </head>
  <body>
    <redoc spec-url="/openapi.yaml"></redoc>
    <script src="https://cdn.redocly.com/redoc/latest/bundles/redoc.standalone.js"></script>
  </body>
</html>`;

export const docsRoutes = new Hono();

docsRoutes.get('/docs', (c) => c.html(DOCS_HTML));

docsRoutes.get('/openapi.yaml', (c) => {
  const yaml = loadSpec();
  c.header('content-type', 'application/yaml; charset=utf-8');
  c.header('cache-control', 'public, max-age=300');
  return c.body(yaml);
});
