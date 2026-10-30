import { handle } from 'hono/aws-lambda';
import { loadRuntimeSecrets } from './config/runtimeSecrets.js';

// Secrets first: env.ts validates process.env when it's imported, so the app
// (and everything that reads env) is imported only after they're loaded.
await loadRuntimeSecrets(process.env);
const { app, runBillRead } = await import('./app.js');
const { isSelfCheckEvent, runSelfCheck } = await import('./ops/selfCheck.js');
const { isBillReadEvent } = await import('./services/bills/readService.js');

const http = handle(app);

/**
 * API Gateway requests go to the Hono app. A direct invoke with
 * `{ "gdpSelfCheck": true }` (from scripts/deps-check.ts after a deploy)
 * runs the dependency checks instead, and `{ "gdpBillRead": … }` (this
 * Lambda invoking itself from POST /v1/bills/reads) reads a bill in the
 * background. API Gateway can't send either shape.
 */
export const handler = async (
  event: Parameters<typeof http>[0],
  context: Parameters<typeof http>[1],
): Promise<unknown> => {
  if (isSelfCheckEvent(event)) return runSelfCheck();
  if (isBillReadEvent(event)) return runBillRead(event.gdpBillRead);
  return http(event, context);
};
