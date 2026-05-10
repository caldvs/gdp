import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import {
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  createBillFor,
  sampleParsedBill,
} from './helpers.js';

const buildApp = () =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
  });

describe('GET /v1/bills/:billId/image-url', () => {
  beforeAll(ensureBillsBucket);

  it('returns a presigned URL for the bill creator', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const bill = await createBillFor(app, userId);

    const res = await app.request(`/v1/bills/${bill.billId}/image-url`, {
      headers: makeAuth(userId),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; expiresAt: string };
    expect(body.url).toMatch(/^https?:\/\//);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('returns 404 BILL_NOT_FOUND for a non-creator non-participant', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const stranger = `s-${uuidv7()}`;
    const bill = await createBillFor(app, creator);

    const res = await app.request(`/v1/bills/${bill.billId}/image-url`, {
      headers: makeAuth(stranger),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('BILL_NOT_FOUND');
  });

  it('lets a session participant fetch the image url', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const bill = await createBillFor(app, creator);

    const sessionRes = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const session = (await sessionRes.json()) as { sessionId: string };
    await app.request(`/v1/sessions/${session.sessionId}/share`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    await app.request(`/v1/sessions/${session.sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(guest),
    });

    const res = await app.request(`/v1/bills/${bill.billId}/image-url`, {
      headers: makeAuth(guest),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toMatch(/^https?:\/\//);
  });

  it('returns 404 NOT_FOUND for a bill missing uploadId (legacy)', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const bill = await createBillFor(app, userId);

    // Simulate a legacy bill by clearing parsedFrom.uploadId on the latest row.
    const { billStore } = await import('../../src/storage/billStore.js');
    const latest = await billStore.getLatest(bill.billId);
    expect(latest).toBeTruthy();
    const { uploadId: _uploadId, ...parsedFromWithoutUpload } = latest!.parsedFrom;
    await billStore.putVersion({
      ...latest!,
      parsedFrom: parsedFromWithoutUpload,
    });

    const res = await app.request(`/v1/bills/${bill.billId}/image-url`, {
      headers: makeAuth(userId),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });
});
