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

// Swagger UI: interactive, with "Try it out" against this API. Pinned so a
// new release can't change the page under us. The spec's first server is a
// placeholder, so the page puts the origin it was served from first.
const SWAGGER_UI_VERSION = '5.34.1';
const SWAGGER_CDN = `https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}`;
const SWAGGER_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Group Dine Pay API · Swagger</title>
    <link rel="stylesheet" href="${SWAGGER_CDN}/swagger-ui.css" />
    <style>body { margin: 0 }</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="${SWAGGER_CDN}/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: true,
        tryItOutEnabled: true,
        displayRequestDuration: true,
        onComplete: function () {
          var spec = window.ui.specSelectors.specJson().toJS();
          var here = { url: window.location.origin, description: 'this server' };
          spec.servers = [here].concat((spec.servers || []).filter(function (s) { return s.url !== here.url; }));
          window.ui.specActions.updateJsonSpec(spec);
        },
      });
    </script>
  </body>
</html>`;

export const docsRoutes = new Hono();

docsRoutes.get('/swagger', (c) => c.html(SWAGGER_HTML));

docsRoutes.get('/docs', (c) => c.html(DOCS_HTML));

docsRoutes.get('/openapi.yaml', (c) => {
  const yaml = loadSpec();
  c.header('content-type', 'application/yaml; charset=utf-8');
  c.header('cache-control', 'public, max-age=300');
  return c.body(yaml);
});
