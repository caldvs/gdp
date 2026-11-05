import type { components } from '../api';

export type DuplicateContext = components['schemas']['DuplicateContext'];

/** Query flag on Review bill: show "Picked up where you left off". */
export const RESUMED_PARAM = 'resumed';

/**
 * Where a photo the lead has sent before takes them
 * (docs/design/analysis-cache.md, step 2): the bill's table when it's in a
 * session (setup, claiming, paying, or settled: the closed bill), else
 * Review bill, saying they've picked up where they left off when it was
 * amended. Older APIs send no context: Review bill.
 */
export function duplicateRoute(billId: string, ctx?: DuplicateContext): string {
  if (ctx?.session && ctx.session.status !== 'abandoned') return `/session/${ctx.session.sessionId}`;
  return ctx?.amended ? `/confirm-bill/${billId}?${RESUMED_PARAM}=1` : `/confirm-bill/${billId}`;
}
