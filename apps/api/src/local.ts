import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { localStubVerifier } from './services/authStub.js';

const port = Number(process.env.PORT ?? 3000);
const bypass = process.env.AUTH_BYPASS_LOCAL === 'true';

if (bypass) {
  if (process.env.NODE_ENV === 'production') {
    console.error('REFUSING TO START: AUTH_BYPASS_LOCAL=true with NODE_ENV=production is unsafe.');
    process.exit(1);
  }
  if (!process.env.DYNAMODB_ENDPOINT) {
    console.error(
      'REFUSING TO START: AUTH_BYPASS_LOCAL=true requires DYNAMODB_ENDPOINT (must be a local stack).',
    );
    process.exit(1);
  }
  console.warn('⚠ AUTH_BYPASS_LOCAL=true — accepting `dev:<userId>` tokens from any caller.');
  console.warn(
    '⚠ Local-only. Refuses to start without local DDB endpoint or with NODE_ENV=production.',
  );
}

const app = bypass ? createApp({ idTokenVerifier: localStubVerifier }) : createApp();

serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(
    `gdp-backend listening on http://localhost:${info.port}${bypass ? ' (auth-bypass)' : ''}`,
  );
});
