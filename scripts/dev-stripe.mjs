// Forwards Stripe test-mode webhooks to the local API so the lead's table-fee
// payment actually completes locally. `npm run dev:local` runs this alongside
// the API and web as the `pay` process.
//
// Without it the payment still completes (the status check asks Stripe about
// the Checkout Session directly), but webhook handling goes untested locally.
//
// Degrades gracefully: if the Stripe CLI isn't installed / logged in, it prints
// how to enable local payments and then idles, so it never tears down the API
// or web (concurrently -k would otherwise kill them when this process exits).
// Set DEV_NO_STRIPE=1 to skip it entirely.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = process.env.PORT ?? '3000';
const FORWARD_TO = `localhost:${PORT}/webhooks/stripe`;
const EVENTS = 'checkout.session.completed,checkout.session.async_payment_succeeded';

const ENV_LOCAL = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'api', '.env.local');

/** Keep the process alive without doing anything, so concurrently -k doesn't tear down api/web. */
function idle() {
  const timer = setInterval(() => {}, 1 << 30);
  // Clear the timer and drop the handlers so the event loop drains and Node
  // exits on its own — this flushes any buffered output, which process.exit() drops.
  const stop = () => {
    clearInterval(timer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

function hint(lines) {
  console.log(['', '  Local card payments are off.', ...lines.map((l) => `  ${l}`), ''].join('\n'));
}

// 1. Opt-out.
if (process.env.DEV_NO_STRIPE === '1') {
  hint(['DEV_NO_STRIPE=1 — skipping the Stripe webhook forwarder.']);
  idle();
}

// 2. Is the CLI installed and logged in? `--print-secret` exits non-zero if not.
//    We only read its exit code; the secret itself is never printed.
else {
  const probe = spawnSync('stripe', ['listen', '--print-secret'], { encoding: 'utf8' });

  if (probe.error?.code === 'ENOENT') {
    hint([
      'Stripe CLI not found. To test the table fee locally:',
      '  brew install stripe/stripe-cli/stripe   (or see stripe.com/docs/stripe-cli)',
      '  stripe login',
      'Then restart `npm run dev:local`. Everything else works without it.',
    ]);
    idle();
  } else if (probe.status !== 0) {
    hint([
      'Stripe CLI is installed but not logged in. Run:',
      '  stripe login',
      'Then restart `npm run dev:local`. Everything else works without it.',
    ]);
    idle();
  } else {
    // 3. The forwarder's signing secret must match STRIPE_WEBHOOK_SECRET in
    //    apps/api/.env.local, or the API rejects every event (AUTH_INVALID).
    //    Compare without printing either value.
    const cliSecret = probe.stdout.trim();
    const envSecret = readEnvSecret();
    if (envSecret && envSecret !== cliSecret) {
      hint([
        'Heads up: STRIPE_WEBHOOK_SECRET in apps/api/.env.local does NOT match',
        'this machine\'s `stripe listen` secret, so events would be rejected.',
        'Fix it with:  stripe listen --print-secret',
        'then paste that whsec_... into apps/api/.env.local and restart.',
      ]);
    }

    // 4. All good — forward events to the local API.
    const child = spawn(
      'stripe',
      ['listen', '--forward-to', FORWARD_TO, '--events', EVENTS],
      { stdio: 'inherit' },
    );

    // On Ctrl-C / concurrently teardown, pass the signal on and exit when the
    // child does. The CLI traps the signal and exits 0 (no signal in `exit`),
    // so we track that WE asked to stop rather than keying off the exit signal.
    let shuttingDown = false;
    const shutDown = (sig) => {
      if (shuttingDown) return;
      shuttingDown = true;
      child.kill(sig);
      // Never let teardown hang: force-kill if it hasn't gone in a few seconds.
      setTimeout(() => child.kill('SIGKILL'), 4000).unref();
    };
    process.on('SIGINT', () => shutDown('SIGINT'));
    process.on('SIGTERM', () => shutDown('SIGTERM'));

    child.on('error', () => {
      hint(['Could not start `stripe listen`. Card payments are off.']);
      idle();
    });
    child.on('exit', (code) => {
      if (shuttingDown) process.exit(0);
      // It died on its own (dropped connection, etc.): don't take api/web down
      // with it — warn and idle so the dev loop keeps running.
      hint([`stripe listen exited (code ${code}). Card payments are off; restart dev to retry.`]);
      idle();
    });
  }
}

/** Best-effort read of STRIPE_WEBHOOK_SECRET from apps/api/.env.local (value never logged). */
function readEnvSecret() {
  try {
    const line = readFileSync(ENV_LOCAL, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('STRIPE_WEBHOOK_SECRET='));
    return line?.slice('STRIPE_WEBHOOK_SECRET='.length).trim().replace(/^["']|["']$/g, '') || null;
  } catch {
    return null;
  }
}
