import { Hono } from 'hono';
import { AppError } from '../errors/AppError.js';
import { countInWindow } from '../storage/rateCounter.js';
import type { GuestTexts } from '../services/sessions/guestTexts.js';
import { sourceIpOf } from './auth.js';

/**
 * #219/#220: the links in guests' texts. No sign-in: the random token is
 * the key. `GET /v1/links/{token}` is the read-only bill (G5);
 * `POST /v1/links/{token}/stop` stops reminders. Both are limited per IP,
 * so tokens can't be guessed at speed.
 */
const LOOKUPS_PER_IP_WINDOW = 60;
const WINDOW_SECONDS = 10 * 60;

export const buildLinkRoutes = (deps: { texts: GuestTexts }): Hono => {
  const r = new Hono();

  const limit = async (env: unknown) => {
    const ip = sourceIpOf(env) ?? 'unknown';
    const ok = await countInWindow(`LINKRATE#${ip}`, WINDOW_SECONDS, LOOKUPS_PER_IP_WINDOW);
    if (!ok.ok) throw new AppError('RATE_LIMITED', 'Too many tries. Wait a few minutes.');
  };

  r.get('/:token', async (c) => {
    await limit(c.env);
    return c.json(await deps.texts.linkView(c.req.param('token')));
  });

  r.post('/:token/stop', async (c) => {
    await limit(c.env);
    await deps.texts.stop(c.req.param('token'));
    return c.json({ stopped: true });
  });

  return r;
};
