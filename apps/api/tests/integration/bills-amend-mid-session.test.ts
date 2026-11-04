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
  setPayoutFor,
} from './helpers.js';

const buildApp = () =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
  });

async function setupSessionInClaiming(app: ReturnType<typeof buildApp>) {
  const creator = `c-${uuidv7()}`;
  const guest = `g-${uuidv7()}`;
  const bill = await createBillFor(app, creator);
  const sRes = await app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(creator) },
    body: JSON.stringify({ billId: bill.billId }),
  });
  const session = (await sRes.json()) as { sessionId: string };
  await setPayoutFor(app, creator);
  await app.request(`/v1/sessions/${session.sessionId}/share`, {
    method: 'POST',
    headers: makeAuth(creator),
  });
  await app.request(`/v1/sessions/${session.sessionId}/join`, {
    method: 'POST',
    headers: makeAuth(guest),
  });
  return { creator, guest, bill, sessionId: session.sessionId };
}

describe('POST /v1/bills/:billId/amend — mid-session', () => {
  beforeAll(ensureBillsBucket);

  it('drops claims for items removed by the amend, and un-readies the participant', async () => {
    const app = buildApp();
    const { creator, guest, bill, sessionId } = await setupSessionInClaiming(app);

    // Guest claims one item.
    const claimedItemId = bill.items[0]!.itemId;
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guest) },
      body: JSON.stringify({ claimedItemIds: [claimedItemId] }),
    });
    await app.request(`/v1/sessions/${sessionId}/ready`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guest) },
      body: JSON.stringify({ ready: true }),
    });

    // Lead amends — drops the item the guest claimed.
    const remainingItem = bill.items[1]!;
    const amend = await app.request(`/v1/bills/${bill.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({
        items: [
          {
            itemId: remainingItem.itemId,
            name: remainingItem.name,
            unitPricePence: remainingItem.unitPricePence,
            quantity: remainingItem.quantity,
            category: 'food' as const,
          },
        ],
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });
    expect(amend.status).toBe(200);

    // Guest's claim should be dropped, ready flag reset.
    const sRes = await app.request(`/v1/sessions/${sessionId}`, {
      headers: makeAuth(guest),
    });
    const refreshed = (await sRes.json()) as {
      pinnedBillVersion: number;
      participants: { userId: string; claimedItemIds: string[]; readyToLock: boolean }[];
    };
    expect(refreshed.pinnedBillVersion).toBe(2);
    const guestPart = refreshed.participants.find((p) => p.userId === guest)!;
    expect(guestPart.claimedItemIds).toHaveLength(0);
    expect(guestPart.readyToLock).toBe(false);
  });

  it('preserves claims for items whose itemId is unchanged', async () => {
    const app = buildApp();
    const { creator, guest, bill, sessionId } = await setupSessionInClaiming(app);

    const keptItem = bill.items[1]!;
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guest) },
      body: JSON.stringify({ claimedItemIds: [keptItem.itemId] }),
    });

    const amend = await app.request(`/v1/bills/${bill.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({
        items: bill.items.map((it) => ({
          itemId: it.itemId,
          name: it.name === keptItem.name ? `${it.name} (corrected)` : it.name,
          unitPricePence: it.unitPricePence,
          quantity: it.quantity,
          category: 'food' as const,
        })),
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });
    expect(amend.status).toBe(200);

    const sRes = await app.request(`/v1/sessions/${sessionId}`, {
      headers: makeAuth(guest),
    });
    const refreshed = (await sRes.json()) as {
      participants: { userId: string; claimedItemIds: string[] }[];
    };
    const guestPart = refreshed.participants.find((p) => p.userId === guest)!;
    expect(guestPart.claimedItemIds).toEqual([keptItem.itemId]);
  });

  it('counts a split’s units when a quantity goes down', async () => {
    const app = buildApp();
    const { creator, guest, bill, sessionId } = await setupSessionInClaiming(app);
    const itemId = bill.items[0]!.itemId;
    const amend = (qty: number) =>
      app.request(`/v1/bills/${bill.billId}/amend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...makeAuth(creator) },
        body: JSON.stringify({
          items: bill.items.map((it) => ({
            itemId: it.itemId,
            name: it.name,
            unitPricePence: it.unitPricePence,
            quantity: it.itemId === itemId ? qty : it.quantity,
            category: 'food' as const,
          })),
          taxPence: 0,
          serviceChargePence: 0,
        }),
      });
    expect((await amend(3)).status).toBe(200);
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guest) },
      body: JSON.stringify({ claimedItemIds: [itemId] }),
    });
    // The other two are split.
    const split = await app.request(`/v1/sessions/${sessionId}/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ itemId }),
    });
    expect(split.status).toBe(200);

    const down = await amend(2);
    expect(down.status).toBe(409);
    const body = (await down.json()) as { error: { code: string; details?: { claimed?: number } } };
    expect(body.error.code).toBe('CLAIMS_EXCEED_QUANTITY');
    expect(body.error.details?.claimed).toBe(3);
  });

  it('rejects with CLAIMS_EXCEED_QUANTITY when new quantity orphans existing claims', async () => {
    const app = buildApp();
    const { creator, guest, bill, sessionId } = await setupSessionInClaiming(app);

    // Guest claims one unit.
    const itemId = bill.items[0]!.itemId;
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guest) },
      body: JSON.stringify({ claimedItemIds: [itemId] }),
    });

    // Try to amend with quantity=0 — but quantity is positive in the schema,
    // so simulate the orphan by setting quantity 1 → set guest claim to 2 first
    // would also need quantity=1 retained. Easier path: claim two of an item
    // (both creator + guest) then amend down to quantity 1.
    // Re-do: pick an item with quantity 1, have both claim a different unit.
    // Since sampleParsedBill has all qty=1, we can't really set count > 1 here.
    // Instead: use `setClaims` to claim same item twice in one call → that's
    // rejected by setClaims. So the simplest reproduction is: amend a multi-qty
    // item down. But sampleParsedBill is qty=1. So we can't replicate inside
    // this test via the normal claim path.
    //
    // Workaround: amend the bill to qty=3, claim 2 units, then amend down to 1.
    const upRes = await app.request(`/v1/bills/${bill.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({
        items: bill.items.map((it) => ({
          itemId: it.itemId,
          name: it.name,
          unitPricePence: it.unitPricePence,
          quantity: it.itemId === itemId ? 3 : it.quantity,
          category: 'food' as const,
        })),
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });
    expect(upRes.status).toBe(200);

    // Guest claims 2 units now.
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(guest) },
      body: JSON.stringify({ claimedItemIds: [itemId, itemId] }),
    });

    // Amend down to 1 — should fail.
    const downRes = await app.request(`/v1/bills/${bill.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({
        items: bill.items.map((it) => ({
          itemId: it.itemId,
          name: it.name,
          unitPricePence: it.unitPricePence,
          quantity: 1,
          category: 'food' as const,
        })),
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });
    expect(downRes.status).toBe(409);
    const body = (await downRes.json()) as {
      error: {
        code: string;
        details?: { itemId?: string; claimed?: number; newQuantity?: number };
      };
    };
    expect(body.error.code).toBe('CLAIMS_EXCEED_QUANTITY');
    expect(body.error.details?.itemId).toBe(itemId);
    expect(body.error.details?.claimed).toBe(2);
    expect(body.error.details?.newQuantity).toBe(1);
  });

  it('still rejects amend once the session is in paying', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const bill = await createBillFor(app, creator);
    const sRes = await app.request('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ billId: bill.billId }),
    });
    const session = (await sRes.json()) as { sessionId: string };
    // Creator claims everything (one of each in sampleParsedBill).
    await app.request(`/v1/sessions/${session.sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ claimedItemIds: bill.items.map((it) => it.itemId) }),
    });
    await setPayoutFor(app, creator);
    await app.request(`/v1/sessions/${session.sessionId}/share`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    await app.request(`/v1/sessions/${session.sessionId}/lock-claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ force: true }),
    });

    const amend = await app.request(`/v1/bills/${bill.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({
        items: [{ name: 'too late', unitPricePence: 100, quantity: 1, category: 'food' as const }],
        taxPence: 0,
        serviceChargePence: 0,
      }),
    });
    expect(amend.status).toBe(409);
    const body = (await amend.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_INVALID_STATE');
  });

  it('a venue set mid-session updates the session too', async () => {
    const app = buildApp();
    const { creator, bill, sessionId } = await setupSessionInClaiming(app);

    await app.request(`/v1/bills/${bill.billId}/amend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({
        items: bill.items.map((it) => ({
          itemId: it.itemId,
          name: it.name,
          unitPricePence: it.unitPricePence,
          quantity: it.quantity,
          category: 'food' as const,
        })),
        taxPence: 0,
        serviceChargePence: 0,
        venue: { name: 'The New Place' },
      }),
    });

    const session = await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(creator) });
    const sessionBody = (await session.json()) as { venue?: { name: string } };
    expect(sessionBody.venue?.name).toBe('The New Place');
  });
});
