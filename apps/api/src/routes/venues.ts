import { Hono } from 'hono';
import { requireAuth } from '../middleware/auth.js';
import type { IdTokenVerifier } from '../services/auth.js';
import { parsePosition, type NearbyVenueService } from '../services/venues/nearbyVenues.js';

export interface VenueRoutesDeps {
  idTokenVerifier?: IdTokenVerifier;
  nearby: NearbyVenueService;
}

export const buildVenueRoutes = (deps: VenueRoutesDeps): Hono => {
  const r = new Hono();

  // Where the lead might be, for the scan screen (#62). The position is in
  // the query string, which the request log leaves out (it logs the path).
  r.get('/nearby', requireAuth(deps.idTokenVerifier), async (c) => {
    const at = parsePosition(c.req.query('lat'), c.req.query('lng'));
    return c.json({ venues: await deps.nearby.nearby(at) });
  });

  return r;
};
