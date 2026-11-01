/**
 * Rules the product depends on, known bugs pinned as `it.fails`, and races.
 *
 * `it.fails` marks a known bug: the test states the behaviour we want and
 * currently fails. When a fix lands it starts passing, Vitest reports the
 * `it.fails` as failed, and the fix's PR changes it to `it`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import type { ParsedBillFromImage } from '../../src/services/bills/parser.js';
import { ddb, TABLE_NAME } from '../../src/storage/ddb.js';
import {
  createBillFor,
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  newIdempotencyKey,
  sampleParsedBill,
  setPayoutFor,
} from './helpers.js';

// Pizza ×1, IPA ×6, Tiramisu ×1, Wine bottle ×1 (splittable).
const parsed: ParsedBillFromImage = {
  ...sampleParsedBill,
  items: [
    { name: 'Margherita Pizza', unitPricePence: 1450, quantity: 1, category: 'food' },
    { name: 'Pint of IPA', unitPricePence: 650, quantity: 6, category: 'drink' },
    { name: 'Tiramisu', unitPricePence: 750, quantity: 1, category: 'food' },
    { name: 'Bottle of house red', unitPricePence: 2400, quantity: 1, category: 'drink' },
  ],
  serviceChargePence: 0,
  taxPence: 0,
  totalPence: 1450 + 650 * 6 + 750 + 2400,
};

const buildApp = () =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(parsed),
    paymentProvider: null, // manual transfers, as in production today
  });
type App = ReturnType<typeof buildApp>;

type Item = { itemId: string; name: string; unitPricePence: number; quantity: number };
type Session = {
  sessionId: string;
  status: string;
  participants: {
    userId: string;
    claimedItemIds: string[];
    sharedItemIds: string[];
    payment: { status: string; paymentId?: string };
  }[];
  shares?: { itemId: string; userIds: string[]; ways: number }[];
};

const json = (body: unknown) => ({
  'content-type': 'application/json',
  body: JSON.stringify(body),
});

async function post(app: App, path: string, user: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: {
      ...makeAuth(user),
      'idempotency-key': newIdempotencyKey(),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: json(body).body }),
  });
}

async function getSession(app: App, sessionId: string, user: string): Promise<Session> {
  const res = await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(user) });
  expect(res.status).toBe(200);
  return (await res.json()) as Session;
}

/** A shared bill in `claiming` with the guests joined and nothing claimed. */
async function claimingTable(app: App, guestCount: number) {
  const lead = `lead-${uuidv7()}`;
  const guests = Array.from({ length: guestCount }, (_, i) => `g${i}-${uuidv7()}`);
  const bill = (await createBillFor(app, lead)) as { billId: string; items: Item[] };
  const created = await post(app, '/v1/sessions', lead, { billId: bill.billId });
  const { sessionId } = (await created.json()) as { sessionId: string };
  await setPayoutFor(app, lead);
  expect((await post(app, `/v1/sessions/${sessionId}/share`, lead)).status).toBe(200);
  for (const g of guests) {
    expect((await post(app, `/v1/sessions/${sessionId}/join`, g)).status).toBe(200);
  }
  const byName = (prefix: string) => bill.items.find((i) => i.name.startsWith(prefix))!;
  return {
    lead,
    guests,
    sessionId,
    bill,
    pizza: byName('Margherita'),
    ipa: byName('Pint'),
    tiramisu: byName('Tiramisu'),
    wine: byName('Bottle'),
  };
}

const claim = (app: App, sessionId: string, user: string, itemIds: string[]) =>
  post(app, `/v1/sessions/${sessionId}/claims`, user, { claimedItemIds: itemIds });

/** Guest pays and the lead confirms it. */
async function payAndConfirm(app: App, sessionId: string, guest: string, lead: string) {
  const init = await post(app, `/v1/sessions/${sessionId}/payments`, guest);
  expect(init.status).toBe(201);
  const { payment } = (await init.json()) as { payment: { paymentId: string } };
  const confirm = await post(app, `/v1/payments/${payment.paymentId}/confirm`, lead);
  expect(confirm.status).toBe(200);
  return payment.paymentId;
}

const unitsClaimed = (s: Session, itemId: string) =>
  s.participants.reduce((n, p) => n + p.claimedItemIds.filter((id) => id === itemId).length, 0);

const amendBody = (items: (Item & { category?: 'food' | 'drink' })[]) => ({
  items: items.map((i) => ({
    itemId: i.itemId,
    name: i.name,
    unitPricePence: i.unitPricePence,
    quantity: i.quantity,
    category: i.category ?? 'food',
  })),
  taxPence: 0,
  serviceChargePence: 0,
});

beforeAll(ensureBillsBucket);

describe('payments', () => {
  it('a guest has one payment: a second initiate is refused', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    expect((await post(app, `/v1/sessions/${t.sessionId}/payments`, g)).status).toBe(201);
    // A fresh idempotency key: a genuinely second payment, not a replay.
    const second = await post(app, `/v1/sessions/${t.sessionId}/payments`, g);
    expect(second.status).toBe(409);
  });

  it('the lead does not pay themselves', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    await claim(app, t.sessionId, t.lead, [t.pizza.itemId]);
    expect((await post(app, `/v1/sessions/${t.sessionId}/payments`, t.lead)).status).toBe(409);
  });
});

describe('known bugs (it.fails until fixed)', () => {
  it.fails("a guest who has paid can't change what they claimed", async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    await payAndConfirm(app, t.sessionId, g, t.lead);

    const change = await claim(app, t.sessionId, g, [t.tiramisu.itemId]);
    expect(change.status).toBe(409);
  });

  it.fails('closing a bill releases it, so the lead can share it again', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    expect((await post(app, `/v1/sessions/${t.sessionId}/close`, t.lead)).status).toBe(200);

    const again = await post(app, '/v1/sessions', t.lead, { billId: t.bill.billId });
    expect(again.status).toBe(201);
  });

  it.fails('removing a split line from the bill removes the split too', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2);
    const shared = await post(app, `/v1/sessions/${t.sessionId}/shares`, t.guests[0]!, {
      itemId: t.wine.itemId,
      ways: 2,
    });
    expect(shared.status).toBe(200);

    const amend = await post(
      app,
      `/v1/bills/${t.bill.billId}/amend`,
      t.lead,
      amendBody([t.pizza, t.ipa, t.tiramisu]),
    );
    expect(amend.status).toBe(200);

    const s = await getSession(app, t.sessionId, t.lead);
    expect(s.shares?.find((x) => x.itemId === t.wine.itemId)).toBeUndefined();
    expect(s.participants.every((p) => !p.sharedItemIds.includes(t.wine.itemId))).toBe(true);
  });
  // Claims are a read-check-write with no condition on the write, so two
  // simultaneous claims both pass the check.
  it.fails(
    'two guests grabbing the last unit at once: one gets it, the item is never over-claimed',
    async () => {
      const app = buildApp();
      const t = await claimingTable(app, 2);
      const [g0, g1] = t.guests as [string, string];
      const results = await Promise.all([
        claim(app, t.sessionId, g0, [t.pizza.itemId]),
        claim(app, t.sessionId, g1, [t.pizza.itemId]),
      ]);
      const s = await getSession(app, t.sessionId, t.lead);
      expect(unitsClaimed(s, t.pizza.itemId)).toBeLessThanOrEqual(1);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    },
  );
});

describe('amending the bill under claims (current behaviour, pending a decision)', () => {
  // See "Amending a bill mid-session" in claude/test-and-coverage-plan.md.
  // These pin today's behaviour so a change to it is deliberate.

  it('lowering a quantity below the units claimed is refused', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    await claim(app, t.sessionId, t.guests[0]!, [t.ipa.itemId, t.ipa.itemId, t.ipa.itemId]);
    const amend = await post(
      app,
      `/v1/bills/${t.bill.billId}/amend`,
      t.lead,
      amendBody([t.pizza, { ...t.ipa, quantity: 2 }, t.tiramisu, t.wine]),
    );
    expect(amend.status).toBe(409);
    expect(((await amend.json()) as { error: { code: string } }).error.code).toBe(
      'CLAIMS_EXCEED_QUANTITY',
    );
  });

  it("removing a line a paid guest claimed is accepted today, and drops the guest's claim", async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    await payAndConfirm(app, t.sessionId, g, t.lead);

    const amend = await post(
      app,
      `/v1/bills/${t.bill.billId}/amend`,
      t.lead,
      amendBody([t.ipa, t.tiramisu, t.wine]),
    );
    expect(amend.status).toBe(200);
    const s = await getSession(app, t.sessionId, t.lead);
    const guest = s.participants.find((p) => p.userId === g)!;
    expect(guest.claimedItemIds).toEqual([]);
    expect(guest.payment.status).toBe('succeeded');
  });

  it('re-pricing a line a paid guest claimed is accepted today', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    await payAndConfirm(app, t.sessionId, g, t.lead);

    const amend = await post(
      app,
      `/v1/bills/${t.bill.billId}/amend`,
      t.lead,
      amendBody([{ ...t.pizza, unitPricePence: 9999 }, t.ipa, t.tiramisu, t.wine]),
    );
    expect(amend.status).toBe(200);
  });
});

describe('storage invariants', () => {
  it('the session META row never holds shares or shareSettings', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2);
    const [g0, g1] = t.guests as [string, string];
    const meta = async () =>
      (
        await ddb.send(
          new GetCommand({ TableName: TABLE_NAME, Key: { pk: `SESS#${t.sessionId}`, sk: 'META' } }),
        )
      ).Item!;
    const check = async (step: string) => {
      const row = await meta();
      expect(row, step).toBeDefined();
      expect(Object.keys(row), step).not.toContain('shares');
      expect(Object.keys(row), step).not.toContain('shareSettings');
    };

    await check('after share');
    await post(app, `/v1/sessions/${t.sessionId}/shares`, g0, { itemId: t.wine.itemId, ways: 3 });
    await check('after starting a split');
    await post(app, `/v1/sessions/${t.sessionId}/shares`, g1, { itemId: t.wine.itemId });
    await check('after joining a split');
    await app.request(`/v1/sessions/${t.sessionId}/shares/${t.wine.itemId}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...makeAuth(g0) },
      body: JSON.stringify({ ways: 2 }),
    });
    await check('after changing ways');
    await claim(app, t.sessionId, g0, [t.pizza.itemId]);
    await check('after a claim');
    await post(
      app,
      `/v1/bills/${t.bill.billId}/amend`,
      t.lead,
      amendBody([t.pizza, t.ipa, t.tiramisu, t.wine]),
    );
    await check('after an amend');
    await post(app, `/v1/sessions/${t.sessionId}/close`, t.lead);
    await check('after close');
  });
});

describe('races', () => {
  it('six guests grabbing one pint each of six: all get one, never more than six', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 6);
    const results = await Promise.all(
      t.guests.map((g) => claim(app, t.sessionId, g, [t.ipa.itemId])),
    );
    const s = await getSession(app, t.sessionId, t.lead);
    expect(unitsClaimed(s, t.ipa.itemId)).toBe(6);
    expect(results.every((r) => r.status === 200)).toBe(true);
  });

  it('two people joining a full split at once: both are in it and it widens to fit', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 3);
    const [g0, g1, g2] = t.guests as [string, string, string];
    await post(app, `/v1/sessions/${t.sessionId}/shares`, g0, { itemId: t.wine.itemId, ways: 2 });
    await post(app, `/v1/sessions/${t.sessionId}/shares`, g1, { itemId: t.wine.itemId });
    const results = await Promise.all([
      post(app, `/v1/sessions/${t.sessionId}/shares`, g2, { itemId: t.wine.itemId }),
      post(app, `/v1/sessions/${t.sessionId}/shares`, t.lead, { itemId: t.wine.itemId }),
    ]);
    // A lost race may be refused (409) for the client to retry; it must
    // never leave a sharer out of the split while reporting success.
    const s = await getSession(app, t.sessionId, t.lead);
    const share = s.shares!.find((x) => x.itemId === t.wine.itemId)!;
    for (const [i, g] of [g2, t.lead].entries()) {
      if (results[i]!.status === 200) expect(share.userIds).toContain(g);
      else expect(results[i]!.status).toBe(409);
    }
    expect(share.ways).toBeGreaterThanOrEqual(share.userIds.length);
  });

  it('ten people joining at once all make it onto the table', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 0);
    const people = Array.from({ length: 10 }, (_, i) => `p${i}-${uuidv7()}`);
    const results = await Promise.all(
      people.map((p) => post(app, `/v1/sessions/${t.sessionId}/join`, p)),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const s = await getSession(app, t.sessionId, t.lead);
    for (const p of people) expect(s.participants.map((x) => x.userId)).toContain(p);
  });
});
