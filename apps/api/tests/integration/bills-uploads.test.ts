import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { billStore } from '../../src/storage/billStore.js';
import { fakeVerifier, makeAuth, sampleParsedBill } from './helpers.js';

const sha256Of = (s: string) => createHash('sha256').update(s).digest('hex');

const buildApp = () =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
  });

describe('POST /v1/bills/uploads', () => {
  const app = buildApp();
  const userId = `u-${uuidv7()}`;

  it('rejects unauthenticated requests', async () => {
    const res = await app.request('/v1/bills/uploads', {
      method: 'POST',
      body: JSON.stringify({
        sha256: sha256Of('x'),
        sizeBytes: 1024,
        mimeType: 'image/jpeg',
      }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects invalid input with INVALID_INPUT and field errors', async () => {
    const res = await app.request('/v1/bills/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        sha256: 'not-hex',
        sizeBytes: -1,
        mimeType: 'image/gif',
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe('INVALID_INPUT');
  });

  it('rejects images larger than 5MB', async () => {
    const res = await app.request('/v1/bills/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        sha256: sha256Of('big'),
        sizeBytes: 6 * 1024 * 1024,
        mimeType: 'image/jpeg',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('returns a pre-signed URL with status=new for a fresh hash', async () => {
    const res = await app.request('/v1/bills/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        sha256: sha256Of(`fresh-${uuidv7()}`),
        sizeBytes: 1024,
        mimeType: 'image/jpeg',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      uploadId: string;
      url: string;
      expiresAt: string;
      maxBytes: number;
    };
    expect(body.status).toBe('new');
    expect(body.uploadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.url).toMatch(/^http(s)?:\/\//);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("short-circuits with status=duplicate when the sha256 already maps to one of the caller's bills", async () => {
    const knownHash = sha256Of(`dup-${uuidv7()}`);
    const knownBillId = uuidv7();
    await billStore.indexImageHash(userId, knownHash, knownBillId);

    const res = await app.request('/v1/bills/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        sha256: knownHash,
        sizeBytes: 1024,
        mimeType: 'image/jpeg',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; billId?: string };
    expect(body.status).toBe('duplicate');
    expect(body.billId).toBe(knownBillId);
  });

  it("does NOT leak another user's billId via hash dedupe", async () => {
    const knownHash = sha256Of(`crossuser-${uuidv7()}`);
    const otherUser = `other-${uuidv7()}`;
    const otherBillId = uuidv7();
    await billStore.indexImageHash(otherUser, knownHash, otherBillId);

    const res = await app.request('/v1/bills/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({
        sha256: knownHash,
        sizeBytes: 1024,
        mimeType: 'image/jpeg',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; billId?: string };
    expect(body.status).toBe('new');
    expect(body.billId).toBeUndefined();
  });
});
