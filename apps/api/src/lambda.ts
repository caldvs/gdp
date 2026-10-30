import { handle } from 'hono/aws-lambda';
import { app } from './app.js';
import { isSelfCheckEvent, runSelfCheck } from './ops/selfCheck.js';

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
