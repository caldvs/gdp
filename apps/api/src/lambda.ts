import { handle } from 'hono/aws-lambda';
import { loadRuntimeSecrets } from './config/runtimeSecrets.js';

// Secrets first: env.ts validates process.env when it's imported, so the app
// (and everything that reads env) is imported only after they're loaded.
await loadRuntimeSecrets(process.env);
const { app, runBillRead, runHoldSweepNow, runLeadEmailsNow, runRemindersNow } =
  await import('./app.js');
const { isSelfCheckEvent, runSelfCheck } = await import('./ops/selfCheck.js');
const { isBillReadEvent } = await import('./services/bills/readService.js');
const { isHoldSweepEvent } = await import('./ops/holdSweep.js');
const { isLeadEmailsEvent } = await import('./ops/leadEmails.js');
const { isRemindersEvent } = await import('./ops/reminders.js');

const http = handle(app);

/**
 * API Gateway requests go to the Hono app. A direct invoke with
 * `{ "gdpSelfCheck": true }` (from scripts/deps-check.ts after a deploy)
 * runs the dependency checks instead, and `{ "gdpBillRead": … }` (this
 * Lambda invoking itself from POST /v1/bills/reads) reads a bill in the
 * background, and `{ "gdpHoldSweep": true }` (EventBridge, daily) takes
 * the platform fee from holds before they lapse (#168), and
 * `{ "gdpLeadEmails": true }` (EventBridge, daily) emails leads about
 * yesterday's settled bills (#221), and `{ "gdpReminders": true }`
 * (EventBridge, daily) texts guests who still owe (#219). API Gateway can't
 * send any of these shapes.
 */
export const handler = async (
  event: Parameters<typeof http>[0],
  context: Parameters<typeof http>[1],
): Promise<unknown> => {
  if (isSelfCheckEvent(event)) return runSelfCheck();
  if (isBillReadEvent(event)) return runBillRead(event.gdpBillRead);
  if (isHoldSweepEvent(event)) return runHoldSweepNow();
  if (isLeadEmailsEvent(event)) return runLeadEmailsNow();
  if (isRemindersEvent(event)) return runRemindersNow();
  return http(event, context);
};
