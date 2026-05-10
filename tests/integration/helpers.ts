import { v7 as uuidv7 } from 'uuid';
import { PutObjectCommand, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { AppError } from '../../src/errors/AppError.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import type { Hono } from 'hono';
import type { IdTokenVerifier } from '../../src/services/auth.js';
import type { ParsedBillFromImage } from '../../src/services/bills/parser.js';

/**
 * Returns bytes whose SHA-256 is unique per call, so tests don't collide
 * with the bill image-hash dedupe index from previous runs.
 */
export const uniqueImageBytes = (): Uint8Array =>
  new TextEncoder().encode(`fixture-${uuidv7()}-${Math.random()}`);

/**
 * Token format: `tok-<userId>` returns a verified identity for that user.
 * Token `expired-token` throws AUTH_EXPIRED.
 * Anything else throws AUTH_INVALID.
 */
export const fakeVerifier: IdTokenVerifier = (token) => {
  if (token === 'expired-token') return Promise.reject(new AppError('AUTH_EXPIRED', 'expired'));
  if (token.startsWith('tok-')) {
    const userId = token.slice('tok-'.length);
    return Promise.resolve({
      userId,
      email: `${userId}@example.com`,
      name: userId,
      picture: `https://avatar.example/${userId}.png`,
    });
  }
  return Promise.reject(new AppError('AUTH_INVALID', 'invalid'));
};

export const makeAuth = (userId: string): { authorization: string } => ({
  authorization: `Bearer tok-${userId}`,
});

export const newIdempotencyKey = (): string => uuidv7();

/**
 * Set a payout account on a user. Required before /share — see
 * sessionService.share. Tests that go through buildPayingSession get this
 * for free; tests that drive /share directly must call this first.
 */
export async function setPayoutFor(app: Hono, userId: string): Promise<void> {
  await app.request('/v1/me/payout-account', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...makeAuth(userId) },
    body: JSON.stringify({
      sortCode: '040668',
      accountNumber: '00079660',
      accountHolderName: 'Test Lead',
    }),
  });
}

export async function ensureBillsBucket(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BILLS_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BILLS_BUCKET }));
  }
}

export async function createBillFor(
  app: Hono,
  userId: string,
): Promise<{
  billId: string;
  totalPence: number;
  items: { itemId: string; quantity: number; unitPricePence: number; name: string }[];
}> {
  const uploadId = uuidv7();
  await s3.send(
    new PutObjectCommand({
      Bucket: BILLS_BUCKET,
      Key: `${userId}/${uploadId}`,
      Body: uniqueImageBytes(),
      ContentType: 'image/jpeg',
    }),
  );
  const res = await app.request('/v1/bills/parse', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': newIdempotencyKey(),
      ...makeAuth(userId),
    },
    body: JSON.stringify({ uploadId }),
  });
  return (await res.json()) as {
    billId: string;
    totalPence: number;
    items: { itemId: string; quantity: number; unitPricePence: number; name: string }[];
  };
}

/**
 * Creates a session in `paying` state with the creator (collector) +
 * supplied guests. With per-unit claim semantics, every individual unit
 * needs an owner; this helper round-robins units across (creator + guests).
 */
export async function buildPayingSession(
  app: Hono,
  creator: string,
  guests: string[],
): Promise<{
  sessionId: string;
  bill: {
    billId: string;
    totalPence: number;
    items: { itemId: string; quantity: number; unitPricePence: number; name: string }[];
  };
}> {
  const bill = await createBillFor(app, creator);
  const create = await app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(creator) },
    body: JSON.stringify({ billId: bill.billId }),
  });
  const initial = (await create.json()) as { sessionId: string };

  // Round-robin every unit across creator + guests
  const allUsers = [creator, ...guests];
  const buckets = new Map<string, string[]>(allUsers.map((u) => [u, []]));
  let cursor = 0;
  for (const item of bill.items) {
    for (let unit = 0; unit < item.quantity; unit += 1) {
      const owner = allUsers[cursor % allUsers.length]!;
      buckets.get(owner)!.push(item.itemId);
      cursor += 1;
    }
  }

  await app.request(`/v1/sessions/${initial.sessionId}/claims`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(creator) },
    body: JSON.stringify({ claimedItemIds: buckets.get(creator)! }),
  });
  await setPayoutFor(app, creator);
  await app.request(`/v1/sessions/${initial.sessionId}/share`, {
    method: 'POST',
    headers: makeAuth(creator),
  });
  for (const g of guests) {
    await app.request(`/v1/sessions/${initial.sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(g),
    });
    await app.request(`/v1/sessions/${initial.sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(g) },
      body: JSON.stringify({ claimedItemIds: buckets.get(g)! }),
    });
  }
  await app.request(`/v1/sessions/${initial.sessionId}/lock-claims`, {
    method: 'POST',
    // force=true so this helper doesn't have to walk every guest through
    // the new /ready endpoint. Tests focused on the readiness flow exercise
    // the no-force path directly.
    headers: { 'content-type': 'application/json', ...makeAuth(creator) },
    body: JSON.stringify({ force: true }),
  });
  return { sessionId: initial.sessionId, bill };
}

export const sampleParsedBill: ParsedBillFromImage = {
  // All quantity-1 items so the claim distribution in setUpClaiming maps
  // 1:1 with participants for the tests that exercise lock/payment flow.
  // Per-unit semantics are covered separately in allocation.test.ts and the
  // dedicated integration test below.
  items: [
    { name: 'Margherita Pizza', unitPricePence: 1450, quantity: 1, category: 'food' },
    { name: 'Pint of IPA', unitPricePence: 650, quantity: 1, category: 'drink' },
    { name: 'Tiramisu', unitPricePence: 750, quantity: 1, category: 'food' },
  ],
  taxPence: 0,
  serviceChargePence: 356, // ~12.5% on 2850 subtotal
  totalPence: 3206,
  currency: 'GBP',
  venue: { name: 'Pizzeria Test', address: '1 Test Street, London' },
};
