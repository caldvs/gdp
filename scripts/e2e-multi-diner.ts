/**
 * Multi-diner end-to-end test against a locally-running gdp-backend.
 *
 * Walks the full lifecycle:
 *   lead   → upload + parse (REAL Gemini)
 *          → createSession + shareSession
 *          → setClaims (some items)
 *   guest1 → resolveJoinCode + joinSession + setClaims (some items)
 *   guest2 → resolveJoinCode + joinSession + setClaims (remaining items)
 *   lead   → lockClaims
 *   assert: session.status === 'paying', each participant has owedPence,
 *           sum reconciles to bill.totalPence
 *
 * Prereqs:
 *   - `npm run dev` (with AUTH_BYPASS_LOCAL=true and GEMINI_API_KEY set)
 *   - Fixture image at ../gdp-mobile/test-fixtures/receipt.jpg
 *
 * Usage:
 *   AUTH_BYPASS_LOCAL=true npm run dev   # in one terminal
 *   npm run test:e2e:multi               # in another
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

const API = process.env.API_BASE_URL ?? 'http://localhost:3000';
const FIXTURE = process.env.E2E_FIXTURE ?? '../gdp-mobile/test-fixtures/receipt.jpg';

type User = { name: string; id: string; token: string };

function makeUser(name: string): User {
  const id = `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  return { name, id, token: `dev:${id}` };
}

function fail(msg: string, extra?: unknown): never {
  console.error(`\n❌ ${msg}`);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
  process.exit(1);
}

async function call<T = unknown>(
  user: User | null,
  method: string,
  path: string,
  opts: { body?: unknown; idempotencyKey?: string } = {},
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (user) headers.authorization = `Bearer ${user.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      /* leave as text */
    }
  }
  return { status: res.status, body: body as T };
}

function expect(cond: unknown, msg: string, extra?: unknown): asserts cond {
  if (!cond) fail(msg, extra);
}

function fmtGBP(pence: number): string {
  return `£${(pence / 100).toFixed(2)}`;
}

async function main() {
  console.log(`→ API: ${API}`);
  console.log(`→ fixture: ${FIXTURE}`);

  if (!existsSync(FIXTURE)) fail(`Fixture not found at ${FIXTURE}`);

  // Sanity: API alive + auth bypass on (calling /v1/me with a stub token)
  const probe = await call(null, 'GET', '/healthz');
  expect(probe.status === 200, `/healthz expected 200, got ${probe.status}`, probe.body);

  const lead = makeUser('lead');
  const guest1 = makeUser('guest1');
  const guest2 = makeUser('guest2');

  const me = await call<{ userId: string; displayName: string }>(lead, 'GET', '/v1/me');
  expect(me.status === 200, 'lead /v1/me failed (is AUTH_BYPASS_LOCAL=true?)', me);
  expect(me.body.userId === lead.id, 'stub did not echo lead userId', me.body);
  console.log(`  ✓ stub auth: lead.userId=${me.body.userId}`);

  // ─── Lead: upload + parse ─────────────────────────────────────────────────
  console.log('\n── Lead: upload + parse ──');
  const imageBytes = readFileSync(FIXTURE);
  const sha256 = createHash('sha256').update(imageBytes).digest('hex');
  console.log(`  bytes: ${imageBytes.length}, sha256: ${sha256.slice(0, 12)}…`);

  const upload = await call<
    { status: 'new'; uploadId: string; url: string } | { status: 'duplicate'; billId: string }
  >(lead, 'POST', '/v1/bills/uploads', {
    body: { sha256, sizeBytes: imageBytes.length, mimeType: 'image/jpeg' },
  });
  expect(upload.status === 200, 'requestUpload failed', upload);
  console.log(`  ✓ uploads.status=${upload.body.status}`);

  let billId: string;
  if (upload.body.status === 'duplicate') {
    billId = upload.body.billId;
    console.log(`  → duplicate detected, reusing billId=${billId.slice(0, 8)}…`);
  } else {
    const put = await fetch(upload.body.url, {
      method: 'PUT',
      headers: { 'content-type': 'image/jpeg' },
      body: new Uint8Array(imageBytes),
    });
    expect(put.ok, `S3 PUT failed: ${put.status} ${put.statusText}`);
    console.log(`  ✓ S3 PUT ok`);

    const parsed = await call<{
      billId: string;
      totalPence: number;
      items: { itemId: string; name: string; unitPricePence: number; quantity: number }[];
    }>(lead, 'POST', '/v1/bills/parse', {
      body: { uploadId: upload.body.uploadId },
      idempotencyKey: uuidv7(),
    });
    expect(parsed.status === 200, 'parseBill failed', parsed);
    billId = parsed.body.billId;
    console.log(
      `  ✓ parsed: billId=${billId.slice(0, 8)}… items=${parsed.body.items.length} total=${fmtGBP(parsed.body.totalPence)}`,
    );
  }

  // Pull full bill to know the items
  const bill = await call<{
    billId: string;
    totalPence: number;
    subtotalPence: number;
    taxPence: number;
    serviceChargePence: number;
    items: { itemId: string; name: string; unitPricePence: number; quantity: number }[];
  }>(lead, 'GET', `/v1/bills/${billId}`);
  expect(bill.status === 200, 'getBill failed', bill);
  const items = bill.body.items;
  console.log(
    `  ✓ ${items.length} items, total ${fmtGBP(bill.body.totalPence)} (subtotal ${fmtGBP(bill.body.subtotalPence)}, service ${fmtGBP(bill.body.serviceChargePence)}, tax ${fmtGBP(bill.body.taxPence)})`,
  );

  // ─── Lead: create session + share ─────────────────────────────────────────
  console.log('\n── Lead: create session + share ──');
  const create = await call<{ sessionId: string; status: string }>(lead, 'POST', '/v1/sessions', {
    body: { billId },
  });
  expect(create.status === 201, 'createSession failed', create);
  const sessionId = create.body.sessionId;
  console.log(`  ✓ sessionId=${sessionId.slice(0, 8)}… status=${create.body.status}`);

  const share = await call<{ joinCode: string }>(lead, 'POST', `/v1/sessions/${sessionId}/share`);
  expect(share.status === 200, 'shareSession failed', share);
  const joinCode = share.body.joinCode;
  console.log(`  ✓ joinCode=${joinCode}`);

  // ─── Guests: resolve + join ───────────────────────────────────────────────
  console.log('\n── Guests: resolve code + join ──');
  for (const guest of [guest1, guest2]) {
    const lookup = await call<{ sessionId: string }>(
      guest,
      'GET',
      `/v1/sessions/by-code?code=${joinCode}`,
    );
    expect(lookup.status === 200, `${guest.name} resolveJoinCode failed`, lookup);
    expect(lookup.body.sessionId === sessionId, `${guest.name} got wrong sessionId`, lookup.body);

    const join = await call(guest, 'POST', `/v1/sessions/${sessionId}/join`);
    expect(join.status === 200, `${guest.name} joinSession failed`, join);
    console.log(`  ✓ ${guest.name} joined`);
  }

  // ─── Distribute claims (round-robin) ──────────────────────────────────────
  console.log('\n── Claims (round-robin) ──');
  const buckets: Record<string, string[]> = { [lead.id]: [], [guest1.id]: [], [guest2.id]: [] };
  const order = [lead, guest1, guest2];
  items.forEach((it, i) => buckets[order[i % 3]!.id]!.push(it.itemId));
  for (const user of order) {
    const myItems = buckets[user.id]!;
    const claim = await call(user, 'POST', `/v1/sessions/${sessionId}/claims`, {
      body: { claimedItemIds: myItems },
    });
    expect(claim.status === 200, `${user.name} setClaims failed`, claim);
    const itemSummary = items
      .filter((it) => myItems.includes(it.itemId))
      .map((it) => it.name)
      .join(', ');
    console.log(`  ✓ ${user.name} claimed ${myItems.length}: ${itemSummary}`);
  }

  // ─── Lead: lock-claims ────────────────────────────────────────────────────
  console.log('\n── Lead: lock-claims ──');
  const lock = await call<{
    status: string;
    participants: { userId: string; owedPence: number; payment: { status: string } }[];
  }>(lead, 'POST', `/v1/sessions/${sessionId}/lock-claims`);
  expect(lock.status === 200, 'lockClaims failed', lock);
  expect(
    lock.body.status === 'paying',
    `expected status=paying, got ${lock.body.status}`,
    lock.body,
  );
  console.log(`  ✓ status=${lock.body.status}`);

  // ─── Verify ───────────────────────────────────────────────────────────────
  console.log('\n── Verify ──');
  const sumOwed = lock.body.participants.reduce((acc, p) => acc + p.owedPence, 0);
  console.log('  participants:');
  for (const p of lock.body.participants) {
    const u = order.find((x) => x.id === p.userId)?.name ?? p.userId;
    console.log(`    - ${u.padEnd(8)} owes ${fmtGBP(p.owedPence)} (payment: ${p.payment.status})`);
  }
  console.log(`  sum:   ${fmtGBP(sumOwed)}`);
  console.log(`  total: ${fmtGBP(bill.body.totalPence)}`);
  expect(
    sumOwed === bill.body.totalPence,
    `Reconciliation FAIL: owedPence sum (${sumOwed}) !== bill.totalPence (${bill.body.totalPence})`,
  );
  console.log('  ✓ owedPence reconciles to bill.totalPence');

  for (const p of lock.body.participants) {
    expect(
      p.payment.status === 'pending' || p.payment.status === 'unpaid',
      `${p.userId} unexpected payment.status: ${p.payment.status}`,
      p,
    );
  }
  console.log('  ✓ all participants in pre-payment state');

  console.log('\n✅ MULTI-DINER E2E PASSED');
}

main().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
