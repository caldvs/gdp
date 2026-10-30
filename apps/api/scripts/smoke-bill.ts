/* eslint-disable no-console -- CLI script, console is the whole point */

/**
 * Ad-hoc bill smoke test.
 *
 * Sends a real bill image to a running gdp-backend, reads it (real
 * Bedrock), creates a session, and prints what the frontend would see —
 * items, totals, and the venue strapline.
 *
 * Prereqs:
 *   - `npm run dev` (with AUTH_BYPASS_LOCAL=true, BEDROCK_MODEL_ID and
 *     AWS credentials that can call Bedrock in .env.local)
 *
 * Usage:
 *   npm run smoke:bill -- <path-to-image>
 *   API_BASE_URL=http://localhost:3000 npm run smoke:bill -- ~/Pictures/receipt.jpg
 *
 * Targeting deployed dev is intentionally NOT supported: it'd need a
 * real Google ID token, which doesn't pair well with a CLI.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

const API = process.env.API_BASE_URL ?? 'http://localhost:3000';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const fmtGBP = (pence: number): string => `£${(pence / 100).toFixed(2)}`;

function fail(msg: string, extra?: unknown): never {
  console.error(`${RED}✗ ${msg}${RESET}`);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

function ok(msg: string): void {
  console.log(`${GREEN}✓${RESET} ${msg}`);
}

interface UploadResponse {
  status: 'new' | 'duplicate';
  uploadId?: string;
  url?: string;
  billId?: string;
}

interface ParsedBill {
  billId: string;
  totalPence: number;
  subtotalPence: number;
  taxPence: number;
  serviceChargePence: number;
  items: { name: string; unitPricePence: number; quantity: number }[];
  venue?: {
    placeId?: string;
    name?: string;
    address?: string;
    lat?: number;
    lng?: number;
  };
}

interface SessionResponse {
  sessionId: string;
  status: string;
  venue?: ParsedBill['venue'];
}

async function call<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep as text */
    }
  }
  return { status: res.status, body: parsed as T };
}

async function main(): Promise<void> {
  const imagePath = process.argv[2];
  if (!imagePath) {
    fail('Usage: npm run smoke:bill -- <path-to-image>');
  }
  if (!existsSync(imagePath)) fail(`File not found: ${imagePath}`);
  const stat = statSync(imagePath);
  if (!stat.isFile()) fail(`Not a regular file: ${imagePath}`);

  console.log(`${DIM}→ API:   ${API}${RESET}`);
  console.log(`${DIM}→ image: ${imagePath} (${(stat.size / 1024).toFixed(1)} KB)${RESET}`);

  // Probe the API first.
  const probe = await fetch(`${API}/healthz`).catch(() => null);
  if (!probe || !probe.ok) {
    fail(`API not reachable at ${API}. Is \`npm run dev\` running?`);
  }
  ok('API alive');

  const userId = `smoke-${Date.now().toString(36)}`;
  const token = `dev:${userId}`;

  const me = await call<{ userId: string }>(token, 'GET', '/v1/me');
  if (me.status !== 200) {
    fail(
      'GET /v1/me failed — is AUTH_BYPASS_LOCAL=true set on the server? (it accepts `dev:<id>` tokens)',
      me,
    );
  }
  ok(`auth bypass active — userId=${me.body.userId}`);

  const bytes = readFileSync(imagePath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  // Sniff the mime type from the magic bytes. Bedrock + S3 are picky.
  let mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    mimeType = 'image/jpeg';
  } else if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    mimeType = 'image/png';
  } else if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    mimeType = 'image/webp';
  } else {
    fail('Unsupported image type. Use jpeg, png, or webp.');
  }

  const upload = await call<UploadResponse>(token, 'POST', '/v1/bills/uploads', {
    sha256,
    sizeBytes: bytes.length,
    mimeType,
  });
  if (upload.status !== 200) fail('upload request failed', upload);

  let billId: string;
  if (upload.body.status === 'duplicate') {
    billId = upload.body.billId ?? fail('duplicate response missing billId', upload.body);
    ok(`bill already in DB (duplicate hash) — reusing ${billId.slice(0, 8)}…`);
  } else {
    const put = await fetch(upload.body.url!, {
      method: 'PUT',
      headers: { 'content-type': mimeType },
      body: new Uint8Array(bytes),
    });
    if (!put.ok) fail(`S3 PUT failed: ${put.status}`);
    ok('uploaded to S3');

    console.log(`${DIM}  reading (Bedrock, may take 5-15s)…${RESET}`);
    const t0 = Date.now();
    const parse = await call<ParsedBill>(
      token,
      'POST',
      '/v1/bills/parse',
      { uploadId: upload.body.uploadId },
      uuidv7(),
    );
    if (parse.status !== 200) fail(`parse failed (HTTP ${parse.status})`, parse.body);
    billId = parse.body.billId;
    ok(`parsed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const bill = await call<ParsedBill>(token, 'GET', `/v1/bills/${billId}`);
  if (bill.status !== 200) fail('GET bill failed', bill);

  const sess = await call<SessionResponse>(token, 'POST', '/v1/sessions', { billId });
  if (sess.status !== 201) fail('create session failed', sess);
  ok(`session created — ${sess.body.sessionId.slice(0, 8)}…`);

  console.log(`\n${BOLD}Bill${RESET}`);
  console.log(
    `  ${bill.body.items.length} item(s) — subtotal ${fmtGBP(bill.body.subtotalPence)}, ` +
      `service ${fmtGBP(bill.body.serviceChargePence)}, ` +
      `tax ${fmtGBP(bill.body.taxPence)}, ${BOLD}total ${fmtGBP(bill.body.totalPence)}${RESET}`,
  );
  for (const item of bill.body.items) {
    const line = `${item.quantity}× ${item.name}`;
    console.log(
      `    ${line.padEnd(40)} ${fmtGBP(item.unitPricePence * item.quantity).padStart(8)}`,
    );
  }

  console.log(`\n${BOLD}Venue (from session response, what the frontend sees)${RESET}`);
  if (sess.body.venue) {
    const { name, address } = sess.body.venue;
    console.log(`  name:    ${name ?? DIM + '(none)' + RESET}`);
    console.log(`  address: ${address ?? DIM + '(none)' + RESET}`);
  } else {
    console.log(`  ${DIM}(none — no venue could be read from this image)${RESET}`);
  }

  console.log();
}

main().catch((err: unknown) => {
  console.error(`${RED}✗ unhandled${RESET}`, err);
  process.exit(1);
});
