/**
 * Rules the product depends on, and races.
 *
 * `it.fails` marks a known bug: the test states the behaviour we want and
 * currently fails. When a fix lands it starts passing, Vitest reports the
 * `it.fails` as failed, and the fix's PR changes it to `it`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '../../src/lib/uuid.js';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ConsoleSmsSender } from '../../src/services/messaging/sms.js';
import { guestPhoneStore } from '../../src/storage/guestPhoneStore.js';
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
  });
type App = ReturnType<typeof buildApp>;

type Item = { itemId: string; name: string; unitPricePence: number; quantity: number };
type Session = {
  sessionId: string;
  status: string;
  paymentsOpenedAt?: string;
  allClaimed?: boolean;
  paymentsOpen?: boolean;
  participants: {
    userId: string;
    claimedItemIds: string[];
    sharedItemIds: string[];
    payment: { status: string; paymentId?: string };
    payments?: { paymentId: string; amountPence: number; status: string }[];
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
/**
 * A shared bill with guests at it. Payments are open (the lead's *Let people
 * pay now*, #216) unless `open: false`, so tests can pay with lines unclaimed.
 */
async function claimingTable(app: App, guestCount: number, { open = true } = {}) {
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
  if (open)
    expect((await post(app, `/v1/sessions/${sessionId}/open-payments`, lead)).status).toBe(200);
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

/** Open (or re-open) a payment for whatever the guest owes now. */
async function initiate(app: App, sessionId: string, guest: string) {
  const res = await post(app, `/v1/sessions/${sessionId}/payments`, guest);
  expect(res.status).toBe(201);
  return ((await res.json()) as { payment: { paymentId: string; amountPence: number } }).payment;
}

const guestOf = (s: Session, userId: string) => s.participants.find((p) => p.userId === userId)!;

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

describe('payments open once every line is claimed (#216)', () => {
  const allOf = (items: Item[], except: string[] = []) =>
    items
      .filter((i) => !except.includes(i.itemId))
      .flatMap((i) => Array.from({ length: i.quantity }, () => i.itemId));

  it('nobody can pay while a line is open; claiming the last line opens payments for everyone', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2, { open: false });
    const [a, b] = t.guests as [string, string];
    expect(
      (await claim(app, t.sessionId, a, allOf(t.bill.items, [t.tiramisu.itemId]))).status,
    ).toBe(200);
    expect(await getSession(app, t.sessionId, a)).toMatchObject({
      allClaimed: false,
      paymentsOpen: false,
    });

    const refused = await post(app, `/v1/sessions/${t.sessionId}/payments`, a);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      error: { code: string; details: { unclaimedItemIds: string[] } };
    };
    expect(body.error.code).toBe('PAYMENTS_NOT_OPEN');
    expect(body.error.details.unclaimedItemIds).toEqual([t.tiramisu.itemId]);

    // The last line claimed: open for everyone, with no word from the lead.
    expect((await claim(app, t.sessionId, b, [t.tiramisu.itemId])).status).toBe(200);
    const view = await getSession(app, t.sessionId, a);
    expect(view).toMatchObject({ allClaimed: true, paymentsOpen: true });
    expect(view.paymentsOpenedAt).toBeUndefined();
    await initiate(app, t.sessionId, a);
    await initiate(app, t.sessionId, b);
  });

  it('a split with a spot open keeps payments closed until someone takes it', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2, { open: false });
    const [a, b] = t.guests as [string, string];
    expect(
      (await claim(app, t.sessionId, a, allOf(t.bill.items, [t.tiramisu.itemId]))).status,
    ).toBe(200);
    expect(
      (
        await post(app, `/v1/sessions/${t.sessionId}/shares`, a, {
          itemId: t.tiramisu.itemId,
          ways: 2,
        })
      ).status,
    ).toBe(200);
    expect((await getSession(app, t.sessionId, a)).allClaimed).toBe(false);
    expect((await post(app, `/v1/sessions/${t.sessionId}/payments`, a)).status).toBe(409);
    expect(
      (await post(app, `/v1/sessions/${t.sessionId}/shares`, b, { itemId: t.tiramisu.itemId }))
        .status,
    ).toBe(200);
    expect(await getSession(app, t.sessionId, a)).toMatchObject({
      allClaimed: true,
      paymentsOpen: true,
    });
    await initiate(app, t.sessionId, b);
  });

  it('the lead can open payments early, and only the lead can', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2, { open: false });
    const [a, b] = t.guests as [string, string];
    expect((await claim(app, t.sessionId, a, [t.pizza.itemId])).status).toBe(200);
    expect((await post(app, `/v1/sessions/${t.sessionId}/payments`, a)).status).toBe(409);

    expect((await post(app, `/v1/sessions/${t.sessionId}/open-payments`, b)).status).toBe(404);
    const opened = await post(app, `/v1/sessions/${t.sessionId}/open-payments`, t.lead);
    expect(opened.status).toBe(200);
    const at = ((await opened.json()) as Session).paymentsOpenedAt;
    expect(at).toBeTruthy();
    // Again: the first time is kept.
    const again = (await (
      await post(app, `/v1/sessions/${t.sessionId}/open-payments`, t.lead)
    ).json()) as Session;
    expect(again.paymentsOpenedAt).toBe(at);
    expect(await getSession(app, t.sessionId, a)).toMatchObject({
      paymentsOpenedAt: at,
      paymentsOpen: true,
      allClaimed: false,
    });

    const payment = await initiate(app, t.sessionId, a);
    expect(payment.amountPence).toBeGreaterThanOrEqual(t.pizza.unitPricePence);
    // Something nobody's claimed stays unclaimed; the lead covers it at close.
    expect(guestOf(await getSession(app, t.sessionId, t.lead), b).claimedItemIds).toEqual([]);
  });
});

describe('payments', () => {
  it('opening the pay page again reuses the payment not sent yet', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    const first = await initiate(app, t.sessionId, g);
    // A fresh idempotency key: a genuinely second request, not a replay.
    const again = await initiate(app, t.sessionId, g);
    expect(again.paymentId).toBe(first.paymentId);
    expect(again.amountPence).toBe(1450);
  });

  it('a payment not sent yet is replaced when the guest changes their picks first', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    const first = await initiate(app, t.sessionId, g);
    // Back to their items: dropping one is fine, nothing has been sent.
    expect((await claim(app, t.sessionId, g, [t.tiramisu.itemId])).status).toBe(200);
    const second = await initiate(app, t.sessionId, g);
    expect(second.paymentId).not.toBe(first.paymentId);
    expect(second.amountPence).toBe(750);
    const me = guestOf(await getSession(app, t.sessionId, g), g);
    expect(me.payments?.map((e) => [e.amountPence, e.status])).toEqual([[750, 'pending']]);
  });

  it('once the guest has sent everything, there is nothing more to pay', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    const p = await initiate(app, t.sessionId, g);
    expect((await post(app, `/v1/payments/${p.paymentId}/mark-paid`, g)).status).toBe(200);
    expect((await post(app, `/v1/sessions/${t.sessionId}/payments`, g)).status).toBe(409);
  });

  it('the lead does not pay themselves', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    await claim(app, t.sessionId, t.lead, [t.pizza.itemId]);
    expect((await post(app, `/v1/sessions/${t.sessionId}/payments`, t.lead)).status).toBe(409);
  });
});

describe('the lead marks money received', () => {
  const received = (app: App, t: { sessionId: string; lead: string }, guest: string, by = t.lead) =>
    post(app, `/v1/sessions/${t.sessionId}/participants/${guest}/received`, by);
  const ledgerOf = (s: Session, g: string) =>
    (guestOf(s, g).payments ?? []).map((e) => [e.amountPence, e.status]);

  it('settles a guest who never said they’d paid', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    const res = await received(app, t, g);
    expect(res.status).toBe(200);
    expect(ledgerOf((await res.json()) as Session, g)).toEqual([[1450, 'succeeded']]);
    // Nothing more to pay.
    expect((await post(app, `/v1/sessions/${t.sessionId}/payments`, g)).status).toBe(409);
  });

  it('confirms what they say they sent and records the rest', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    const first = await initiate(app, t.sessionId, g);
    expect((await post(app, `/v1/payments/${first.paymentId}/mark-paid`, g)).status).toBe(200);
    await claim(app, t.sessionId, g, [t.pizza.itemId, t.tiramisu.itemId]);
    await received(app, t, g);
    const s = await getSession(app, t.sessionId, t.lead);
    expect(ledgerOf(s, g)).toEqual([
      [1450, 'succeeded'],
      [750, 'succeeded'],
    ]);
  });

  it('closes a payment opened but not sent, instead of confirming its amount', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId, t.tiramisu.itemId]);
    const draft = await initiate(app, t.sessionId, g);
    await received(app, t, g);
    const s = await getSession(app, t.sessionId, t.lead);
    expect(ledgerOf(s, g)).toEqual([
      [2200, 'failed'],
      [2200, 'succeeded'],
    ]);
    const old = await app.request(`/v1/payments/${draft.paymentId}`, { headers: makeAuth(g) });
    expect(((await old.json()) as { status: string }).status).toBe('failed');
  });

  it('a second tap changes nothing', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    await received(app, t, g);
    const again = await received(app, t, g);
    expect(again.status).toBe(200);
    expect(ledgerOf((await again.json()) as Session, g)).toEqual([[1450, 'succeeded']]);
  });

  it('only the lead can, and not for themselves', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2);
    const [g0, g1] = t.guests as [string, string];
    await claim(app, t.sessionId, g0, [t.pizza.itemId]);
    expect((await received(app, t, g0, g1)).status).toBe(404);
    expect((await received(app, t, t.lead)).status).toBe(404);
  });

  it('still works after the bill is closed', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    expect((await post(app, `/v1/sessions/${t.sessionId}/close`, t.lead)).status).toBe(200);
    const res = await received(app, t, g);
    expect(res.status).toBe(200);
    expect(ledgerOf((await res.json()) as Session, g)).toEqual([[1450, 'succeeded']]);
  });
});

describe('after paying (#121: top-ups)', () => {
  it('a guest who has paid can add something they forgot and pay just the difference', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    const firstId = await payAndConfirm(app, t.sessionId, g, t.lead);

    expect((await claim(app, t.sessionId, g, [t.pizza.itemId, t.tiramisu.itemId])).status).toBe(
      200,
    );
    const top = await initiate(app, t.sessionId, g);
    expect(top.amountPence).toBe(750);
    expect((await post(app, `/v1/payments/${top.paymentId}/mark-paid`, g)).status).toBe(200);

    // Both payments are on the guest's list; the first stays as it was.
    let me = guestOf(await getSession(app, t.sessionId, t.lead), g);
    expect(me.payments?.map((e) => [e.paymentId, e.amountPence, e.status])).toEqual([
      [firstId, 1450, 'succeeded'],
      [top.paymentId, 750, 'pending'],
    ]);
    expect(me.payment.status).toBe('pending');

    // The lead confirms the top-up like any other payment.
    expect((await post(app, `/v1/payments/${top.paymentId}/confirm`, t.lead)).status).toBe(200);
    me = guestOf(await getSession(app, t.sessionId, t.lead), g);
    expect(me.payments?.every((e) => e.status === 'succeeded')).toBe(true);
    expect(me.payment.status).toBe('succeeded');
    expect((await post(app, `/v1/sessions/${t.sessionId}/payments`, g)).status).toBe(409);
  });

  it('a reminder asks a part-paid guest for what’s left, not their whole share', async () => {
    const sms = new ConsoleSmsSender();
    const app = createApp({
      idTokenVerifier: fakeVerifier,
      billParser: new FixtureBillParser(parsed),
      phoneSms: sms,
    });
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await guestPhoneStore.put(t.sessionId, g, '+447700900123');
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    await payAndConfirm(app, t.sessionId, g, t.lead);
    // Paid in full: nothing to remind.
    const remind = () => post(app, `/v1/sessions/${t.sessionId}/participants/${g}/remind`, t.lead);
    expect((await remind()).status).toBe(409);

    // Adds the tiramisu: £7.50 left to pay, and that's what the text says.
    await claim(app, t.sessionId, g, [t.pizza.itemId, t.tiramisu.itemId]);
    expect((await remind()).status).toBe(200);
    expect(sms.outbox.at(-1)!.body).toMatch(/^You owe \S+ £7\.50\b/);
  });

  it('a top-up can go before the lead has confirmed the first payment', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    const first = await initiate(app, t.sessionId, g);
    expect((await post(app, `/v1/payments/${first.paymentId}/mark-paid`, g)).status).toBe(200);

    expect((await claim(app, t.sessionId, g, [t.pizza.itemId, t.ipa.itemId])).status).toBe(200);
    const top = await initiate(app, t.sessionId, g);
    expect(top.amountPence).toBe(650);
    expect((await post(app, `/v1/payments/${top.paymentId}/mark-paid`, g)).status).toBe(200);
    for (const id of [first.paymentId, top.paymentId]) {
      expect((await post(app, `/v1/payments/${id}/confirm`, t.lead)).status).toBe(200);
    }
    const me = guestOf(await getSession(app, t.sessionId, t.lead), g);
    expect(me.payments?.map((e) => e.status)).toEqual(['succeeded', 'succeeded']);
  });

  it('nobody gets money back: a guest can’t drop what they’ve paid for', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    await payAndConfirm(app, t.sessionId, g, t.lead);
    const res = await claim(app, t.sessionId, g, []);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ALREADY_PAID_FOR');
    // Swapping for something dearer is fine: they top up the difference.
    expect((await claim(app, t.sessionId, g, [t.wine.itemId])).status).toBe(200);
  });

  it('others’ payments don’t change when someone takes the last unit', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 3);
    const [a, b, bob] = t.guests as [string, string, string];
    await claim(app, t.sessionId, a, [t.ipa.itemId]);
    await claim(app, t.sessionId, b, [t.ipa.itemId]);
    await payAndConfirm(app, t.sessionId, a, t.lead);
    await payAndConfirm(app, t.sessionId, b, t.lead);
    await claim(app, t.sessionId, bob, [t.ipa.itemId]);
    expect((await initiate(app, t.sessionId, bob)).amountPence).toBe(650);
    const s = await getSession(app, t.sessionId, t.lead);
    for (const u of [a, b]) {
      expect(guestOf(s, u).payments?.map((e) => [e.amountPence, e.status])).toEqual([
        [650, 'succeeded'],
      ]);
    }
  });
});

describe('splitting something someone else claimed (#130)', () => {
  it('turns their claim into a 2-way split at once, and both owe half', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2);
    const [priya, tom] = t.guests as [string, string];
    await claim(app, t.sessionId, priya, [t.wine.itemId, t.pizza.itemId]);
    const res = await post(app, `/v1/sessions/${t.sessionId}/shares`, tom, {
      itemId: t.wine.itemId,
    });
    expect(res.status).toBe(200);
    const s = (await res.json()) as Omit<Session, 'shares'> & {
      shares: { itemId: string; userIds: string[]; ways: number; activity: unknown[] }[];
    };
    expect(guestOf(s, priya).claimedItemIds).toEqual([t.pizza.itemId]);
    expect(guestOf(s, priya).sharedItemIds).toEqual([t.wine.itemId]);
    expect(guestOf(s, tom).sharedItemIds).toEqual([t.wine.itemId]);
    const share = s.shares.find((x) => x.itemId === t.wine.itemId)!;
    expect(share.ways).toBe(2);
    expect([...share.userIds].sort()).toEqual([priya, tom].sort());
    expect(share.activity).toEqual([
      expect.objectContaining({ kind: 'split', byUserId: tom, fromUserId: priya, toWays: 2 }),
    ]);
    expect((await initiate(app, t.sessionId, tom)).amountPence).toBe(1200);
    expect((await initiate(app, t.sessionId, priya)).amountPence).toBe(1450 + 1200);
  });

  it('a third person joins the split as one more way', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 3);
    const [priya, tom, sam] = t.guests as [string, string, string];
    await claim(app, t.sessionId, priya, [t.wine.itemId]);
    await post(app, `/v1/sessions/${t.sessionId}/shares`, tom, { itemId: t.wine.itemId });
    await post(app, `/v1/sessions/${t.sessionId}/shares`, sam, { itemId: t.wine.itemId });
    const s = await getSession(app, t.sessionId, t.lead);
    expect(s.shares?.find((x) => x.itemId === t.wine.itemId)?.ways).toBe(3);
    expect((await initiate(app, t.sessionId, sam)).amountPence).toBe(800);
  });

  it('is refused once the person who claimed it has paid: what they paid never changes', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2);
    const [priya, tom] = t.guests as [string, string];
    await claim(app, t.sessionId, priya, [t.wine.itemId]);
    await payAndConfirm(app, t.sessionId, priya, t.lead);
    const res = await post(app, `/v1/sessions/${t.sessionId}/shares`, tom, {
      itemId: t.wine.itemId,
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('SHARE_PAID');
    const s = await getSession(app, t.sessionId, t.lead);
    expect(guestOf(s, priya).claimedItemIds).toEqual([t.wine.itemId]);
    expect(s.shares ?? []).toEqual([]);
  });

  it('works on something the lead claimed', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, t.lead, [t.tiramisu.itemId]);
    const res = await post(app, `/v1/sessions/${t.sessionId}/shares`, g, {
      itemId: t.tiramisu.itemId,
    });
    expect(res.status).toBe(200);
    expect((await initiate(app, t.sessionId, g)).amountPence).toBe(375);
  });
});

describe('closing a bill', () => {
  it('releases it, so the lead can share it again', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    expect((await post(app, `/v1/sessions/${t.sessionId}/close`, t.lead)).status).toBe(200);

    const again = await post(app, '/v1/sessions', t.lead, { billId: t.bill.billId });
    expect(again.status).toBe(201);
  });

  it('guests can still read the bill and pay afterwards', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2);
    const [paid, late] = t.guests as [string, string];
    await claim(app, t.sessionId, paid, [t.pizza.itemId]);
    await payAndConfirm(app, t.sessionId, paid, t.lead);
    await claim(app, t.sessionId, late, [t.tiramisu.itemId]);
    expect((await post(app, `/v1/sessions/${t.sessionId}/close`, t.lead)).status).toBe(200);

    for (const g of [paid, late]) {
      const bill = await app.request(`/v1/bills/${t.bill.billId}`, { headers: makeAuth(g) });
      expect(bill.status, g).toBe(200);
    }
    expect((await post(app, `/v1/sessions/${t.sessionId}/payments`, late)).status).toBe(201);

    // Someone who was never at the table still can't.
    const stranger = await app.request(`/v1/bills/${t.bill.billId}`, {
      headers: makeAuth(`x-${uuidv7()}`),
    });
    expect(stranger.status).toBe(404);
  });

  it("amending the bill after closing doesn't change the closed session's bill", async () => {
    const app = buildApp();
    const t = await claimingTable(app, 1);
    const g = t.guests[0]!;
    await claim(app, t.sessionId, g, [t.pizza.itemId]);
    await post(app, `/v1/sessions/${t.sessionId}/close`, t.lead);
    const before = await getSession(app, t.sessionId, g);

    const amend = await post(
      app,
      `/v1/bills/${t.bill.billId}/amend`,
      t.lead,
      amendBody([{ ...t.pizza, unitPricePence: 9999 }, t.ipa, t.tiramisu, t.wine]),
    );
    expect(amend.status).toBe(200);
    const after = (await getSession(app, t.sessionId, g)) as Session & {
      pinnedBillVersion: number;
    };
    expect(after.pinnedBillVersion).toBe((before as typeof after).pinnedBillVersion);
    const pinned = await app.request(
      `/v1/bills/${t.bill.billId}?version=${after.pinnedBillVersion}`,
      { headers: makeAuth(g) },
    );
    const items = ((await pinned.json()) as { items: Item[] }).items;
    expect(items.find((i) => i.itemId === t.pizza.itemId)!.unitPricePence).toBe(1450);
  });
});

describe('amending the bill under claims', () => {
  // Decided 1 Nov: no freeze on lines a guest has paid for. The lead can
  // still remove or re-price them; only orphaning claims is refused.

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

  it("removing a line a paid guest claimed is allowed and drops the guest's claim", async () => {
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

  it('re-pricing a line a paid guest claimed is allowed', async () => {
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

  it('removing a split line removes the split too', async () => {
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
    const row = await ddb.send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { pk: `SESS#${t.sessionId}`, sk: `SHARE#${t.wine.itemId}` },
      }),
    );
    expect(row.Item).toBeUndefined();
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
  it('two guests grabbing the last unit at once: one gets it, the other is told it has gone', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2);
    const [g0, g1] = t.guests as [string, string];
    const results = await Promise.all([
      claim(app, t.sessionId, g0, [t.pizza.itemId]),
      claim(app, t.sessionId, g1, [t.pizza.itemId]),
    ]);
    const s = await getSession(app, t.sessionId, t.lead);
    expect(unitsClaimed(s, t.pizza.itemId)).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });

  it('a claim racing a split of the same item: never both', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 2);
    const [g0, g1] = t.guests as [string, string];
    await Promise.all([
      claim(app, t.sessionId, g0, [t.wine.itemId]),
      post(app, `/v1/sessions/${t.sessionId}/shares`, g1, { itemId: t.wine.itemId, ways: 2 }),
    ]);
    const s = await getSession(app, t.sessionId, t.lead);
    const claimed = unitsClaimed(s, t.wine.itemId) > 0;
    const split = (s.shares ?? []).some((x) => x.itemId === t.wine.itemId && x.userIds.length > 0);
    expect(claimed && split).toBe(false);
  });

  it('two people splitting the same claimed item at once: both end up in it (#130)', async () => {
    const app = buildApp();
    const t = await claimingTable(app, 3);
    const [owner, a, b] = t.guests as [string, string, string];
    await claim(app, t.sessionId, owner, [t.wine.itemId]);
    const results = await Promise.all(
      [a, b].map((u) =>
        post(app, `/v1/sessions/${t.sessionId}/shares`, u, { itemId: t.wine.itemId }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const s = await getSession(app, t.sessionId, t.lead);
    const share = s.shares?.find((x) => x.itemId === t.wine.itemId);
    expect([...(share?.userIds ?? [])].sort()).toEqual([owner, a, b].sort());
    expect(share?.ways).toBe(3);
    expect(unitsClaimed(s, t.wine.itemId)).toBe(0);
  });

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

  // A race only shows when the writes interleave, so each of these runs a
  // few tables at once.
  const TABLES = 6;

  it('a guest paying while claiming more: neither write undoes the other', async () => {
    const app = buildApp();
    await Promise.all(
      Array.from({ length: TABLES }, async () => {
        const t = await claimingTable(app, 1);
        const g = t.guests[0]!;
        expect((await claim(app, t.sessionId, g, [t.pizza.itemId])).status).toBe(200);
        const [pay, more] = await Promise.all([
          post(app, `/v1/sessions/${t.sessionId}/payments`, g),
          claim(app, t.sessionId, g, [t.pizza.itemId, t.tiramisu.itemId]),
        ]);
        expect(pay.status).toBe(201);
        expect(more.status).toBe(200);
        const { payment } = (await pay.json()) as { payment: { paymentId: string } };
        const me = guestOf(await getSession(app, t.sessionId, t.lead), g);
        expect(me.claimedItemIds).toContain(t.tiramisu.itemId);
        expect(me.payments?.map((e) => e.paymentId)).toContain(payment.paymentId);
        // The row version is storage's own; clients never see it.
        expect(me).not.toHaveProperty('rev');
      }),
    );
  });

  it('the lead confirming a payment while the guest claims more: both stick', async () => {
    const app = buildApp();
    await Promise.all(
      Array.from({ length: TABLES }, async () => {
        const t = await claimingTable(app, 1);
        const g = t.guests[0]!;
        expect((await claim(app, t.sessionId, g, [t.pizza.itemId])).status).toBe(200);
        const p = await initiate(app, t.sessionId, g);
        const [confirm, more] = await Promise.all([
          post(app, `/v1/payments/${p.paymentId}/confirm`, t.lead),
          claim(app, t.sessionId, g, [t.pizza.itemId, t.tiramisu.itemId]),
        ]);
        expect(confirm.status).toBe(200);
        expect(more.status).toBe(200);
        const me = guestOf(await getSession(app, t.sessionId, t.lead), g);
        expect(me.claimedItemIds).toContain(t.tiramisu.itemId);
        expect(me.payments?.find((e) => e.paymentId === p.paymentId)?.status).toBe('succeeded');
      }),
    );
  });

  it('the lead marking received while the guest claims more: both stick', async () => {
    const app = buildApp();
    await Promise.all(
      Array.from({ length: TABLES }, async () => {
        const t = await claimingTable(app, 1);
        const g = t.guests[0]!;
        expect((await claim(app, t.sessionId, g, [t.pizza.itemId])).status).toBe(200);
        const [got, more] = await Promise.all([
          post(app, `/v1/sessions/${t.sessionId}/participants/${g}/received`, t.lead),
          claim(app, t.sessionId, g, [t.pizza.itemId, t.tiramisu.itemId]),
        ]);
        expect(got.status).toBe(200);
        expect(more.status).toBe(200);
        const me = guestOf(await getSession(app, t.sessionId, t.lead), g);
        expect(me.claimedItemIds).toContain(t.tiramisu.itemId);
        expect(me.payments?.some((e) => e.status === 'succeeded')).toBe(true);
      }),
    );
  });

  it('the same payment request sent twice at once opens one payment', async () => {
    const app = buildApp();
    await Promise.all(
      Array.from({ length: TABLES }, async () => {
        const t = await claimingTable(app, 1);
        const g = t.guests[0]!;
        expect((await claim(app, t.sessionId, g, [t.pizza.itemId])).status).toBe(200);
        const key = newIdempotencyKey();
        const send = () =>
          app.request(`/v1/sessions/${t.sessionId}/payments`, {
            method: 'POST',
            headers: { ...makeAuth(g), 'idempotency-key': key },
          });
        const results = await Promise.all([send(), send()]);
        // The second either replays the first or is told it's still running.
        const ids = new Set<string>();
        for (const r of results) {
          if (r.status === 201) {
            ids.add(((await r.json()) as { payment: { paymentId: string } }).payment.paymentId);
          } else {
            expect(r.status).toBe(409);
          }
        }
        expect(ids.size).toBe(1);
        const me = guestOf(await getSession(app, t.sessionId, t.lead), g);
        expect(me.payments).toHaveLength(1);
      }),
    );
  });
});
