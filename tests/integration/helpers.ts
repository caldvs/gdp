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
    });
  }
  return Promise.reject(new AppError('AUTH_INVALID', 'invalid'));
};

export const makeAuth = (userId: string): { authorization: string } => ({
  authorization: `Bearer tok-${userId}`,
});

export const newIdempotencyKey = (): string => uuidv7();

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
): Promise<{ billId: string; totalPence: number; items: { itemId: string }[] }> {
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
    items: { itemId: string }[];
  };
}

/**
 * Creates a session in `paying` state with the creator (collector) +
 * supplied guests, distributing one item to each (creator → item[0],
 * guests[i] → item[i+1]). All participants have owedPence computed.
 */
export async function buildPayingSession(
  app: Hono,
  creator: string,
  guests: string[],
): Promise<{
  sessionId: string;
  bill: { billId: string; totalPence: number; items: { itemId: string }[] };
}> {
  const bill = await createBillFor(app, creator);
  const create = await app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(creator) },
    body: JSON.stringify({ billId: bill.billId }),
  });
  const initial = (await create.json()) as { sessionId: string };

  // Creator claims item[0] plus any leftover items beyond what guests get.
  const creatorItemIds = [bill.items[0]!.itemId];
  for (let i = guests.length + 1; i < bill.items.length; i += 1) {
    creatorItemIds.push(bill.items[i]!.itemId);
  }
  await app.request(`/v1/sessions/${initial.sessionId}/claims`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(creator) },
    body: JSON.stringify({ claimedItemIds: creatorItemIds }),
  });
  await app.request(`/v1/sessions/${initial.sessionId}/share`, {
    method: 'POST',
    headers: makeAuth(creator),
  });
  for (const [i, g] of guests.entries()) {
    await app.request(`/v1/sessions/${initial.sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(g),
    });
    await app.request(`/v1/sessions/${initial.sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(g) },
      body: JSON.stringify({ claimedItemIds: [bill.items[i + 1]!.itemId] }),
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
  items: [
    { name: 'Margherita Pizza', unitPricePence: 1450, quantity: 2, category: 'food' },
    { name: 'Pint of IPA', unitPricePence: 650, quantity: 3, category: 'drink' },
    { name: 'Tiramisu', unitPricePence: 750, quantity: 1, category: 'food' },
  ],
  taxPence: 0, // VAT typically baked in for UK menu prices
  serviceChargePence: 575, // 12.5% on 4600 subtotal = 575
  totalPence: 5175,
  currency: 'GBP',
  venue: { name: 'Pizzeria Test', address: '1 Test Street, London' },
};
