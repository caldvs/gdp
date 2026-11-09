import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { stringify } from 'yaml';
import { openApiDocument } from './document.js';

/** apps/api/openapi.yaml. */
export const SPEC_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'openapi.yaml');

const HEADER =
  '# Generated from apps/api/src/openapi by `npm run gen:openapi -w apps/api`. Edit the Zod there, not this file.\n';

/** openapi.yaml as committed: formatted as the pre-commit hook's prettier leaves it. */
export async function renderSpec(): Promise<string> {
  const yaml = stringify(openApiDocument(), { lineWidth: 0, aliasDuplicateObjects: false });
  return format(HEADER + yaml, { ...(await resolveConfig(SPEC_FILE)), filepath: SPEC_FILE });
}
