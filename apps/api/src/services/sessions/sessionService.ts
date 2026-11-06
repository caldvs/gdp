import type { VerifiedCaller } from '../../context/caller.js';
import { claimMethods } from './sessionClaims.js';
import { joinMethods } from './sessionJoin.js';
import { leadMethods } from './sessionLead.js';
import { lifecycleMethods } from './sessionLifecycle.js';
import { shareMethods } from './sessionShares.js';

export type { VerifiedCaller };

/**
 * Everything a table can do, one object for the routes. Each area lives in
 * its own module. `joinAsGuest` calls `this.join`, so call these as
 * `sessionService.x(...)`.
 */
export const sessionService = {
  ...lifecycleMethods,
  ...joinMethods,
  ...leadMethods,
  ...claimMethods,
  ...shareMethods,
};
