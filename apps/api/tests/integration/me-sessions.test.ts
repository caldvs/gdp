import { describe, it, expect, beforeAll } from 'vitest';
import { uuidv7 } from '../../src/lib/uuid.js';
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
        peopleCount?: number;
        toPayCount?: number;
      }>;
    };
    expect(leadBody.sessions).toHaveLength(1);
    // #223: the lead's open bill says who's at the table and who still has to pay.
    expect(leadBody.sessions[0]?.peopleCount).toBe(2);
    expect(leadBody.sessions[0]?.toPayCount).toBe(1);
    expect(leadBody.sessions[0]?.sessionId).toBe(sessionId);
    expect(leadBody.sessions[0]?.role).toBe('lead');
    expect(leadBody.sessions[0]?.status).toBe('paying');
    expect(leadBody.sessions[0]?.myPaymentStatus).toBe('self_paid');
    expect(typeof leadBody.sessions[0]?.myOwedPence).toBe('number');

    const dinerRes = await app.request('/v1/me/sessions', { headers: makeAuth(diner) });
    const dinerBody = (await dinerRes.json()) as {
      sessions: Array<{ sessionId: string; role: string; peopleCount?: number }>;
    };
    expect(dinerBody.sessions).toHaveLength(1);
    expect(dinerBody.sessions[0]?.role).toBe('diner');
    expect(dinerBody.sessions[0]?.peopleCount).toBeUndefined();
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

  it('carries the bill total and each person’s share: claims, a split and service', async () => {
    // 751 split two ways leaves a penny over: it goes to the lower userId
    // (the lead here), so the guest's part needs the split's other member.
    const parsed = {
      ...sampleParsedBill,
      items: [
        { name: 'Margherita Pizza', unitPricePence: 1450, quantity: 1, category: 'food' as const },
        { name: 'Pint of IPA', unitPricePence: 650, quantity: 1, category: 'drink' as const },
        { name: 'Tiramisu', unitPricePence: 751, quantity: 1, category: 'food' as const },
      ],
      serviceChargePence: 356,
      totalPence: 3207,
    };
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(parsed),
    });
    const lead = `a-lead-${uuidv7()}`;
    const guest = `b-guest-${uuidv7()}`;
    const bill = await createBillFor(app, lead);
    const [pizza, ipa, tiramisu] = bill.items.map((it) => it.itemId);
    const post = (user: string, path: string, body?: unknown) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...makeAuth(user) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    const created = (await (await post(lead, '/v1/sessions', { billId: bill.billId })).json()) as {
      sessionId: string;
    };
    const sid = created.sessionId;
    expect(
      (await post(lead, `/v1/sessions/${sid}/claims`, { claimedItemIds: [pizza] })).status,
    ).toBe(200);
    expect((await post(lead, `/v1/sessions/${sid}/share`)).status).toBe(200);
    expect((await post(guest, `/v1/sessions/${sid}/join`)).status).toBe(200);
    expect(
      (await post(guest, `/v1/sessions/${sid}/claims`, { claimedItemIds: [ipa] })).status,
    ).toBe(200);
    expect(
      (await post(lead, `/v1/sessions/${sid}/shares`, { itemId: tiramisu, ways: 2 })).status,
    ).toBe(200);
    expect((await post(guest, `/v1/sessions/${sid}/shares`, { itemId: tiramisu })).status).toBe(
      200,
    );

    const mine = async (user: string) => {
      const res = await app.request('/v1/me/sessions', { headers: makeAuth(user) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        sessions: Array<{ sessionId: string; billTotalPence?: number; mySharePence?: number }>;
      };
      return body.sessions.find((s) => s.sessionId === sid);
    };
    // Guest: 650 + 375, plus service pro rata (356 / 2851), rounded down:
    // 1025 × 3207 / 2851 = 1152.99. The lead takes the rest of the bill.
    expect(await mine(guest)).toMatchObject({ billTotalPence: 3207, mySharePence: 1152 });
    expect(await mine(lead)).toMatchObject({ billTotalPence: 3207, mySharePence: 3207 - 1152 });

    // The guest leaves the split: their spot reopens, the lead keeps their part.
    await app.request(`/v1/sessions/${sid}/shares/${tiramisu}`, {
      method: 'DELETE',
      headers: makeAuth(guest),
    });
    // The open spot (375) is nobody's: it and its service go on the lead.
    const guestPart = Math.floor((650 * 3207) / 2851);
    const nobody = Math.floor((375 * 3207) / 2851);
    expect((await mine(guest))?.mySharePence).toBe(guestPart);
    expect((await mine(lead))?.mySharePence).toBe(3207 - guestPart - nobody);
  });

  it('a locked bill gives the locked share', async () => {
    const app = buildApp();
    const lead = `lead-${uuidv7()}`;
    const diner = `diner-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, lead, [diner]);
    for (const user of [lead, diner]) {
      const res = await app.request('/v1/me/sessions', { headers: makeAuth(user) });
      const body = (await res.json()) as {
        sessions: Array<{
          sessionId: string;
          billTotalPence?: number;
          mySharePence?: number;
          myOwedPence?: number;
        }>;
      };
      const s = body.sessions.find((x) => x.sessionId === sessionId);
      expect(s?.billTotalPence).toBe(sampleParsedBill.totalPence);
      expect(s?.mySharePence).toBe(s?.myOwedPence);
    }
  });

  it('rejects unauthenticated callers', async () => {
    const app = buildApp();
    const res = await app.request('/v1/me/sessions');
    expect(res.status).toBe(401);
  });
});
