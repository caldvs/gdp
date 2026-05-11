import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import {
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  createBillFor,
  buildPayingSession,
  sampleParsedBill,
} from './helpers.js';

const buildApp = () =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
  });

describe('GET /v1/me/sessions', () => {
  beforeAll(ensureBillsBucket);

  it('returns empty list for a user with no sessions', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const res = await app.request('/v1/me/sessions', { headers: makeAuth(userId) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toEqual([]);
  });

  it('lists sessions for the lead and the diner with the right role', async () => {
    const app = buildApp();
    const lead = `lead-${uuidv7()}`;
    const diner = `diner-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, lead, [diner]);

    const leadRes = await app.request('/v1/me/sessions', { headers: makeAuth(lead) });
    expect(leadRes.status).toBe(200);
    const leadBody = (await leadRes.json()) as {
      sessions: Array<{
        sessionId: string;
        role: 'lead' | 'diner';
        status: string;
        myOwedPence?: number;
        myPaymentStatus: string;
      }>;
    };
    expect(leadBody.sessions).toHaveLength(1);
    expect(leadBody.sessions[0]?.sessionId).toBe(sessionId);
    expect(leadBody.sessions[0]?.role).toBe('lead');
    expect(leadBody.sessions[0]?.status).toBe('paying');
    expect(leadBody.sessions[0]?.myPaymentStatus).toBe('self_paid');
    expect(typeof leadBody.sessions[0]?.myOwedPence).toBe('number');

    const dinerRes = await app.request('/v1/me/sessions', { headers: makeAuth(diner) });
    const dinerBody = (await dinerRes.json()) as {
      sessions: Array<{ sessionId: string; role: string }>;
    };
    expect(dinerBody.sessions).toHaveLength(1);
    expect(dinerBody.sessions[0]?.role).toBe('diner');
  });

  it('includes slimmed venue { name } for list-view strapline', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    const bill = await createBillFor(app, userId);
    await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({ billId: bill.billId }),
    });

    const res = await app.request('/v1/me/sessions', { headers: makeAuth(userId) });
    const body = (await res.json()) as {
      sessions: Array<{ venue?: { name?: string; placeId?: string; lat?: number } }>;
    };
    const summary = body.sessions[0];
    expect(summary?.venue).toEqual({ name: sampleParsedBill.venue!.name });
    // Slim shape only — no placeId / coords / address in list view.
    expect(summary?.venue).not.toHaveProperty('placeId');
    expect(summary?.venue).not.toHaveProperty('lat');
  });

  it('omits venue from summary when the bill had none', async () => {
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser({ ...sampleParsedBill, venue: undefined }),
    });
    const userId = `u-no-venue-${uuidv7()}`;
    const bill = await createBillFor(app, userId);
    await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const res = await app.request('/v1/me/sessions', { headers: makeAuth(userId) });
    const body = (await res.json()) as { sessions: Array<{ venue?: unknown }> };
    expect(body.sessions[0]?.venue).toBeUndefined();
  });

  it('returns sessions most recent first', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    // Create two bills + sessions sequentially. UUIDv7 means session B > session A.
    const billA = await createBillFor(app, userId);
    const sA = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({ billId: billA.billId }),
    });
    const sessA = (await sA.json()) as { sessionId: string };

    const billB = await createBillFor(app, userId);
    const sB = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify({ billId: billB.billId }),
    });
    const sessB = (await sB.json()) as { sessionId: string };

    const res = await app.request('/v1/me/sessions', { headers: makeAuth(userId) });
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    expect(body.sessions.map((s) => s.sessionId)).toEqual([sessB.sessionId, sessA.sessionId]);
  });

  it('honours the limit query param', async () => {
    const app = buildApp();
    const userId = `u-${uuidv7()}`;
    for (let i = 0; i < 3; i += 1) {
      const bill = await createBillFor(app, userId);
      await app.request('/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...makeAuth(userId) },
        body: JSON.stringify({ billId: bill.billId }),
      });
    }
    const res = await app.request('/v1/me/sessions?limit=2', { headers: makeAuth(userId) });
    const body = (await res.json()) as { sessions: unknown[] };
    expect(body.sessions).toHaveLength(2);
  });

  it('rejects unauthenticated callers', async () => {
    const app = buildApp();
    const res = await app.request('/v1/me/sessions');
    expect(res.status).toBe(401);
  });
});
