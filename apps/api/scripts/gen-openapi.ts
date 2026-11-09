/**
 * Writes openapi.yaml from the routes' Zod (src/openapi). With --check, it
 * writes nothing and fails if the committed file is out of date.
 *
 *   npm run gen:openapi -w apps/api            # write openapi.yaml
 *   npm run gen:openapi -w apps/api -- --check # fail on drift
 *
 * `npm run gen:api` at the root runs this, then regenerates the web
 * client's types from the result.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { renderSpec, SPEC_FILE } from '../src/openapi/render.js';

const next = await renderSpec();
if (process.argv.includes('--check')) {
  if (readFileSync(SPEC_FILE, 'utf8') !== next) {
    console.error(
      'openapi.yaml is out of date with src/openapi. Run `npm run gen:api` and commit the result.',
    );
    process.exit(1);
  }
  console.log('openapi.yaml is up to date');
} else {
  writeFileSync(SPEC_FILE, next);
  console.log('wrote openapi.yaml');
}
