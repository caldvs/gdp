import { baseLogger } from './logger.js';

/**
 * Runs a call to an outside service and logs how long it took, as
 * `{ event: 'dep.call', dep, op, ms, ok }`. The dashboard's "Calls out"
 * panel charts these, so a slow or failing Bedrock, Stripe
 * or SES call shows up without tracing. Pass `requestId` in `fields` when
 * there is one, to tie the call to its request line.
 */
export async function timed<T>(
  dep: string,
  op: string,
  call: () => Promise<T>,
  fields: Record<string, unknown> = {},
): Promise<T> {
  const start = performance.now();
  const ms = () => Math.round(performance.now() - start);
  try {
    const result = await call();
    // A fetch Response that came back 4xx/5xx is a failed call too.
    const http =
      result instanceof Response ? { ok: result.ok, status: result.status } : { ok: true };
    baseLogger.info({ event: 'dep.call', dep, op, ms: ms(), ...http, ...fields }, 'dep call');
    return result;
  } catch (err) {
    const e = err as { name?: string; code?: string };
    baseLogger.info(
      { event: 'dep.call', dep, op, ms: ms(), ok: false, errName: e.code ?? e.name, ...fields },
      'dep call',
    );
    throw err;
  }
}
