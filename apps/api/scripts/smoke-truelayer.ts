/* eslint-disable no-console -- CLI script, console is the whole point */

/**
 * TrueLayer sandbox smoke. Creates one real sandbox payment and prints the
 * hosted-payment-page URL so you can click through `mock_payments_gb_redirect`.
 *
 * Reads creds from env vars (same names as the Lambda):
 *   TRUELAYER_CLIENT_ID
 *   TRUELAYER_CLIENT_SECRET
 *   TRUELAYER_SIGNING_KID
 *   TRUELAYER_SIGNING_PRIVATE_KEY_PEM   (or path via _PEM_FILE)
 *   TRUELAYER_RETURN_URI
 *   TRUELAYER_ENVIRONMENT               (defaults to "sandbox")
 *
 * Smoke beneficiary defaults to the sandbox merchant account
 * (sort 040668 / acct 00079660 / Callum Davies). Override with
 *   --sort-code, --account-number, --account-holder-name.
 *
 * Usage:
 *   AWS_PROFILE=gdp-dev tsx scripts/smoke-truelayer.ts                # 1234p default
 *   AWS_PROFILE=gdp-dev tsx scripts/smoke-truelayer.ts --amount 599   # 599p
 *
 * Note: this hits the real TrueLayer sandbox API. Webhook events from the
 * mock bank flow back to whatever you have registered in the TrueLayer
 * Console — nothing in this script listens for them locally.
 */
import { readFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';
import { v7 as uuidv7 } from 'uuid';
import { TrueLayerSandboxProvider } from '../src/services/payments/trueLayerProvider.js';

const required = (name: string): string => {
  const v = env[name];
  if (!v) {
    console.error(`✗ Missing env var: ${name}`);
    exit(1);
  }
  return v;
};

const loadPem = (): string => {
  const inline = env.TRUELAYER_SIGNING_PRIVATE_KEY_PEM;
  if (inline) return inline;
  const path = env.TRUELAYER_SIGNING_PRIVATE_KEY_PEM_FILE;
  if (path) return readFileSync(path, 'utf8');
  console.error('✗ Provide TRUELAYER_SIGNING_PRIVATE_KEY_PEM or _PEM_FILE');
  exit(1);
};

const parseAmount = (): number => {
  const i = argv.indexOf('--amount');
  if (i === -1) return 1234;
  const n = Number(argv[i + 1]);
  if (!Number.isInteger(n) || n <= 0) {
    console.error('✗ --amount must be a positive integer (pence)');
    exit(1);
  }
  return n;
};

const argString = (flag: string, fallback: string): string => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  if (!v) {
    console.error(`✗ ${flag} requires a value`);
    exit(1);
  }
  return v;
};

async function main(): Promise<void> {
  const provider = new TrueLayerSandboxProvider({
    environment: (env.TRUELAYER_ENVIRONMENT as 'sandbox' | 'live') ?? 'sandbox',
    clientId: required('TRUELAYER_CLIENT_ID'),
    clientSecret: required('TRUELAYER_CLIENT_SECRET'),
    signingKid: required('TRUELAYER_SIGNING_KID'),
    signingPrivateKeyPem: loadPem(),
    returnUri: required('TRUELAYER_RETURN_URI'),
  });

  const paymentId = uuidv7();
  const amountPence = parseAmount();
  const beneficiary = {
    sortCode: argString('--sort-code', '040668'),
    accountNumber: argString('--account-number', '00079660'),
    accountHolderName: argString('--account-holder-name', 'Callum Davies'),
  };

  console.log(
    `→ creating sandbox payment ${paymentId} for ${amountPence}p → ${beneficiary.accountHolderName} (${beneficiary.sortCode}/${beneficiary.accountNumber})…`,
  );
  const result = await provider.initiate({
    paymentId,
    amountPence,
    currency: 'GBP',
    payerUserId: `smoke-payer-${paymentId.slice(0, 8)}`,
    collectorUserId: `smoke-collector-${paymentId.slice(0, 8)}`,
    reference: `smoke-${paymentId.slice(0, 8)}`,
    beneficiary,
  });

  console.log('');
  console.log(`✓ providerPaymentId: ${result.providerPaymentId}`);
  console.log('');
  console.log('Open this URL, pick "Mock UK Payments - Redirect Flow", and approve:');
  console.log('');
  console.log(`  ${result.authorizationUrl}`);
  console.log('');
}

main().catch((err: unknown) => {
  console.error('✗ smoke failed:', err);
  if (err && typeof err === 'object' && 'details' in err) {
    const details = (err as { details?: unknown }).details;
    if (details) console.error('  details:', JSON.stringify(details, null, 2));
  }
  exit(1);
});
