import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import type { Hono } from 'hono';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { AppError } from '../../src/errors/AppError.js';
import { s3, BILLS_BUCKET } from '../../src/storage/s3.js';
import type { BillParser } from '../../src/services/bills/parser.js';
import {
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  newIdempotencyKey,
  sampleParsedBill,
  uniqueImageBytes,
} from './helpers.js';

type Read = {
  readId: string;
  status: 'reading' | 'done' | 'failed';
  billId?: string;
  error?: { code: string; message: string };
};

async function upload(userId: string, bytes = uniqueImageBytes()): Promise<string> {
  const uploadId = uuidv7();
  await s3.send(
    new PutObjectCommand({
      Bucket: BILLS_BUCKET,
      Key: `${userId}/${uploadId}`,
      Body: bytes,
      ContentType: 'image/jpeg',
    }),
  );
  return uploadId;
}

async function start(
  app: Hono,
  userId: string,
  uploadId: string,
  extra: { skipCache?: boolean } = {},
): Promise<Response> {
  return app.request('/v1/bills/reads', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key': newIdempotencyKey(),
      ...makeAuth(userId),
    },
    body: JSON.stringify({ uploadId, ...extra }),
  });
}

/** Polls until the read leaves `reading` (in-process reads finish in milliseconds). */
async function settle(app: Hono, userId: string, readId: string): Promise<Read> {
  for (let i = 0; i < 100; i++) {
    const res = await app.request(`/v1/bills/reads/${readId}`, { headers: makeAuth(userId) });
    expect(res.status).toBe(200);
    const read = (await res.json()) as Read;
    if (read.status !== 'reading') return read;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('read never finished');
}

const failing = (err: AppError): BillParser => ({
  model: 'broken',
  version: 'v1',
  parse: () => Promise.reject(err),
});

describe('background bill reads', () => {
  beforeAll(ensureBillsBucket);

  it('starts at once, then finishes with a bill the reader can open', async () => {
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(sampleParsedBill),
    });
    const userId = `u-${uuidv7()}`;
    const res = await start(app, userId, await upload(userId));
    expect(res.status).toBe(202);
    const started = (await res.json()) as Read;
    expect(started.status).toBe('reading');

    const read = await settle(app, userId, started.readId);
    expect(read.status).toBe('done');
    const bill = await app.request(`/v1/bills/${read.billId}`, { headers: makeAuth(userId) });
    expect(bill.status).toBe(200);
    expect(((await bill.json()) as { items: unknown[] }).items).toHaveLength(3);
  });

  it('reads a photo it has seen before again when skipCache is set', async () => {
    let calls = 0;
    const fixture = new FixtureBillParser(sampleParsedBill);
    const counting: BillParser = {
      model: fixture.model,
      version: fixture.version,
      parse: () => {
        calls++;
        return fixture.parse();
      },
    };
    const app = createApp({ idTokenVerifier: fakeVerifier, billParser: counting });
    const userId = `u-${uuidv7()}`;
    const bytes = uniqueImageBytes();
    const readOnce = async (extra: { skipCache?: boolean }) => {
      const started = (await (await start(app, userId, await upload(userId, bytes), extra)).json()) as Read;
      return settle(app, userId, started.readId);
    };

    const first = await readOnce({});
    const cached = await readOnce({});
    expect(cached.billId).toBe(first.billId);
    expect(calls).toBe(1);

    const fresh = await readOnce({ skipCache: true });
    expect(fresh.status).toBe('done');
    expect(fresh.billId).not.toBe(first.billId);
    expect(calls).toBe(2);

    // The fresh bill is now the photo's bill; the old one still opens.
    expect((await readOnce({})).billId).toBe(fresh.billId);
    const old = await app.request(`/v1/bills/${first.billId}`, { headers: makeAuth(userId) });
    expect(old.status).toBe(200);
  });

  it('records a failed read with the same error the parse would give', async () => {
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: failing(
        new AppError('PARSE_LOW_CONFIDENCE', 'No items could be parsed from the image'),
      ),
    });
    const userId = `u-${uuidv7()}`;
    const started = (await (await start(app, userId, await upload(userId))).json()) as Read;
    const read = await settle(app, userId, started.readId);
    expect(read).toMatchObject({ status: 'failed', error: { code: 'PARSE_LOW_CONFIDENCE' } });
    expect(read.billId).toBeUndefined();
  });

  it('fails a read whose upload is missing', async () => {
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(sampleParsedBill),
    });
    const userId = `u-${uuidv7()}`;
    const started = (await (await start(app, userId, uuidv7())).json()) as Read;
    const read = await settle(app, userId, started.readId);
    expect(read).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
  });

  it("hides one user's read from another", async () => {
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(sampleParsedBill),
    });
    const owner = `u-${uuidv7()}`;
    const started = (await (await start(app, owner, await upload(owner))).json()) as Read;
    const res = await app.request(`/v1/bills/reads/${started.readId}`, {
      headers: makeAuth(`u-${uuidv7()}`),
    });
    expect(res.status).toBe(404);
  });

  it('reports a read that could not be started as failed straight away', async () => {
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(sampleParsedBill),
      readDispatcher: () => Promise.reject(new Error('invoke refused')),
    });
    const userId = `u-${uuidv7()}`;
    const res = await start(app, userId, await upload(userId));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ status: 'failed', error: { code: 'INTERNAL_ERROR' } });
  });

  it('needs an Idempotency-Key', async () => {
    const app = createApp({ idTokenVerifier: fakeVerifier });
    const res = await app.request('/v1/bills/reads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth('u1') },
      body: JSON.stringify({ uploadId: uuidv7() }),
    });
    expect(res.status).toBe(400);
  });
});
