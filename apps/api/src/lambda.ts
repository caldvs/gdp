import { handle } from 'hono/aws-lambda';
import { loadRuntimeSecrets } from './config/runtimeSecrets.js';

// Secrets first: env.ts validates process.env when it's imported, so the app
// (and everything that reads env) is imported only after they're loaded.
await loadRuntimeSecrets(process.env);
const { app } = await import('./app.js');
const { isSelfCheckEvent, runSelfCheck } = await import('./ops/selfCheck.js');

const http = handle(app);

/**
 * API Gateway requests go to the Hono app. A direct invoke with
 * `{ "gdpSelfCheck": true }` (from scripts/deps-check.ts after a deploy)
 * runs the dependency checks instead; API Gateway can't send that shape.
 */
export const handler = async (
  event: Parameters<typeof http>[0],
  context: Parameters<typeof http>[1],
): Promise<unknown> => {
  if (isSelfCheckEvent(event)) return runSelfCheck();
  return http(event, context);
};
