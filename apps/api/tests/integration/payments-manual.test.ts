import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { userStore } from '../../src/storage/userStore.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import {
  buildPayingSession,
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  newIdempotencyKey,
  sampleParsedBill,
} from './helpers.js';

const buildApp = () =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
    paymentProvider: null, // explicit manual mode
  });

// The HTTP PUT is deprecated and no-ops per ADR-0002. Tests that
// exercise the legacy manual-payment path (which still reads
// server-side payoutAccount via paymentService) seed the store
// directly.
const setPayoutWith = async (
  _app: ReturnType<typeof buildApp>,
  userId: string,
  extra: { monzoHandle?: string; revolutTag?: string } = {},
): Promise<void> => {
  await userStore.setPayoutAccount(userId, {
    sortCode: '040668',
    accountNumber: '00079660',
    accountHolderName: 'Test Lead',
    ...extra,
  });
};

describe('manual payment mode — initiate returns bank details + optional links', () => {
  beforeAll(ensureBillsBucket);

  it('returns instructions { type: manual_transfer } with bank details + reference', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);

    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guest) },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: { provider: string; status: string };
      instructions: {
        type: string;
        bankDetails: { sortCode: string; accountNumber: string; accountHolderName: string };
        reference: string;
        amountPence: number;
        links: { monzo?: string; revolut?: string };
      };
    };
    expect(body.payment.provider).toBe('manual');
    expect(body.payment.status).toBe('pending');
    expect(body.instructions.type).toBe('manual_transfer');
    expect(body.instructions.bankDetails.sortCode).toBe('040668');
    expect(body.instructions.bankDetails.accountNumber).toBe('00079660');
    expect(body.instructions.bankDetails.accountHolderName).toBe('Test Lead');
    expect(body.instructions.reference).toMatch(/^gdp-[0-9a-f]{8}$/);
    expect(body.instructions.amountPence).toBeGreaterThan(0);
    expect(body.instructions.links).toEqual({}); // no Monzo/Revolut handles set
  });

  it('builds monzo.me link when collector has a monzoHandle', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    // buildPayingSession set bare bank details; overlay the handle.
    await setPayoutWith(app, creator, { monzoHandle: 'callum.davies' });

    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guest) },
    });
    const body = (await res.json()) as {
      instructions: { links: { monzo?: string }; amountPence: number; reference: string };
    };
    const expectedAmount = (body.instructions.amountPence / 100).toFixed(2);
    expect(body.instructions.links.monzo).toBe(
      `https://monzo.me/callum.davies/${expectedAmount}?d=${encodeURIComponent(body.instructions.reference)}&account_type=personal`,
    );
  });

  it('builds revolut.me link when collector has a revolutTag', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    await setPayoutWith(app, creator, { revolutTag: 'callumd' });

    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guest) },
    });
    const body = (await res.json()) as {
      instructions: { links: { revolut?: string }; amountPence: number };
    };
    const expectedAmount = (body.instructions.amountPence / 100).toFixed(2);
    expect(body.instructions.links.revolut).toBe(`https://revolut.me/callumd/${expectedAmount}`);
  });

  it('builds both links when both handles are set', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    await setPayoutWith(app, creator, { monzoHandle: 'callum', revolutTag: 'callumd' });

    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guest) },
    });
    const body = (await res.json()) as {
      instructions: { links: { monzo?: string; revolut?: string } };
    };
    expect(body.instructions.links.monzo).toBeDefined();
    expect(body.instructions.links.revolut).toBeDefined();
  });
});

describe('POST /v1/payments/:id/confirm — collector marks manual receipt', () => {
  beforeAll(ensureBillsBucket);

  const initiate = async (
    app: ReturnType<typeof buildApp>,
    sessionId: string,
    payer: string,
  ): Promise<string> => {
    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(payer) },
    });
    const body = (await res.json()) as { payment: { paymentId: string } };
    return body.payment.paymentId;
  };

  it('flips payment from pending to succeeded', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);

    const res = await app.request(`/v1/payments/${paymentId}/confirm`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; events: { source: string }[] };
    expect(body.status).toBe('succeeded');
    expect(body.events.at(-1)?.source).toBe('api');
  });

  it('settles the session when last guest is confirmed', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const guestB = `b-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA, guestB]);
    for (const g of [guestA, guestB]) {
      const id = await initiate(app, sessionId, g);
      await app.request(`/v1/payments/${id}/confirm`, {
        method: 'POST',
        headers: makeAuth(creator),
      });
    }
    const sess = await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(creator) });
    const body = (await sess.json()) as { status: string };
    expect(body.status).toBe('settled');
  });

  it('is idempotent — confirming twice returns the same succeeded payment', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);

    const first = await app.request(`/v1/payments/${paymentId}/confirm`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    const second = await app.request(`/v1/payments/${paymentId}/confirm`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = (await first.json()) as { status: string; events: unknown[] };
    const b = (await second.json()) as { status: string; events: unknown[] };
    expect(a.status).toBe('succeeded');
    expect(b.status).toBe('succeeded');
    // Idempotent — second call doesn't append a duplicate event.
    expect(b.events.length).toBe(a.events.length);
  });

  it('non-collector cannot confirm — 404 PAYMENT_NOT_FOUND (collector-scoped)', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const interloper = `x-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);

    const res = await app.request(`/v1/payments/${paymentId}/confirm`, {
      method: 'POST',
      headers: makeAuth(interloper),
    });
    expect(res.status).toBe(404);
  });

  it('payer cannot confirm their own payment — only the collector can', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);

    const res = await app.request(`/v1/payments/${paymentId}/confirm`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    expect(res.status).toBe(404);
  });
});
