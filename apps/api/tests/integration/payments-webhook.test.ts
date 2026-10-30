import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { FixtureBillParser } from '../../src/services/bills/fixtureParser.js';
import { MockTrueLayerProvider } from '../../src/services/payments/mockProvider.js';
import {
  buildPayingSession,
  ensureBillsBucket,
  fakeVerifier,
  makeAuth,
  newIdempotencyKey,
  sampleParsedBill,
} from './helpers.js';

const buildApp = () => {
  const provider = new MockTrueLayerProvider('webhook-test-secret');
  const app = createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
    paymentProvider: provider,
  });
  return { app, provider };
};

async function initiate(
  app: ReturnType<typeof buildApp>['app'],
  sessionId: string,
  payer: string,
): Promise<{ paymentId: string; providerPaymentId: string }> {
  const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
    method: 'POST',
    headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(payer) },
  });
  const body = (await res.json()) as {
    payment: { paymentId: string; providerPaymentId: string };
  };
  return { paymentId: body.payment.paymentId, providerPaymentId: body.payment.providerPaymentId };
}

const webhook = (
  provider: MockTrueLayerProvider,
  body: object,
  opts: { signature?: string } = {},
): { headers: Record<string, string>; body: string } => {
  const rawBody = JSON.stringify(body);
  const signature = opts.signature ?? provider.signBody(rawBody);
  return {
    headers: { 'content-type': 'application/json', 'tl-signature': signature },
    body: rawBody,
  };
};

describe('POST /webhooks/truelayer', () => {
  beforeAll(async () => {
    await ensureBillsBucket();
  });

  it('rejects when Tl-Signature header is missing', async () => {
    const { app, provider } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);
    const { providerPaymentId } = await initiate(app, sessionId, guestA);

    const res = await app.request('/webhooks/truelayer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerPaymentId, type: 'authorized' }),
    });
    expect(res.status).toBe(401);
    void provider; // explicit no-op
  });

  it('rejects when the signature does not match the body', async () => {
    const { app, provider } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);
    const { providerPaymentId } = await initiate(app, sessionId, guestA);

    const otherProvider = new MockTrueLayerProvider('different-secret');
    const rawBody = JSON.stringify({ providerPaymentId, type: 'authorized' });
    const wrongSignature = otherProvider.signBody(rawBody);

    const res = await app.request('/webhooks/truelayer', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'tl-signature': wrongSignature },
      body: rawBody,
    });
    expect(res.status).toBe(401);
    void provider;
  });

  it('returns 404 when providerPaymentId is unknown', async () => {
    const { app, provider } = buildApp();
    const { headers, body } = webhook(provider, {
      providerPaymentId: `mock-${uuidv7()}`,
      type: 'authorized',
    });
    const res = await app.request('/webhooks/truelayer', {
      method: 'POST',
      headers,
      body,
    });
    expect(res.status).toBe(404);
    const respBody = (await res.json()) as { error: { code: string } };
    expect(respBody.error.code).toBe('PAYMENT_NOT_FOUND');
  });

  it('progresses pending → authorized → succeeded; participant payment mirrors', async () => {
    const { app, provider } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);
    const { paymentId, providerPaymentId } = await initiate(app, sessionId, guestA);

    let w = webhook(provider, { providerPaymentId, type: 'authorized' });
    let res = await app.request('/webhooks/truelayer', { method: 'POST', ...w });
    expect(res.status).toBe(200);

    let payment = await app.request(`/v1/payments/${paymentId}`, {
      headers: makeAuth(guestA),
    });
    let pay = (await payment.json()) as { status: string; events: unknown[] };
    expect(pay.status).toBe('authorized');
    expect(pay.events.length).toBeGreaterThanOrEqual(2);

    w = webhook(provider, { providerPaymentId, type: 'executed' });
    res = await app.request('/webhooks/truelayer', { method: 'POST', ...w });
    expect(res.status).toBe(200);

    payment = await app.request(`/v1/payments/${paymentId}`, {
      headers: makeAuth(guestA),
    });
    pay = (await payment.json()) as { status: string; events: unknown[] };
    expect(pay.status).toBe('succeeded');

    // participant payment now reflects success
    const session = await app.request(`/v1/sessions/${sessionId}`, {
      headers: makeAuth(guestA),
    });
    const sessionBody = (await session.json()) as {
      participants: { userId: string; payment: { status: string; paymentId?: string } }[];
    };
    const part = sessionBody.participants.find((p) => p.userId === guestA);
    expect(part?.payment.status).toBe('succeeded');
    expect(part?.payment.paymentId).toBe(paymentId);
  });

  it('idempotently replays the same event without changing state', async () => {
    const { app, provider } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);
    const { paymentId, providerPaymentId } = await initiate(app, sessionId, guestA);

    const w = webhook(provider, { providerPaymentId, type: 'authorized' });
    await app.request('/webhooks/truelayer', { method: 'POST', ...w });
    await app.request('/webhooks/truelayer', { method: 'POST', ...w });

    const payment = await app.request(`/v1/payments/${paymentId}`, {
      headers: makeAuth(guestA),
    });
    const pay = (await payment.json()) as { status: string; events: { from: string }[] };
    expect(pay.status).toBe('authorized');
    // create event + first authorized; replay must not append.
    expect(pay.events.filter((e) => e.from === 'pending')).toHaveLength(2); // create + authorized
  });

  it('ignores invalid transitions (returns 200, state unchanged)', async () => {
    const { app, provider } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);
    const { paymentId, providerPaymentId } = await initiate(app, sessionId, guestA);

    // Try to send 'executed' while still pending — invalid (must go via authorized)
    const w = webhook(provider, { providerPaymentId, type: 'executed' });
    const res = await app.request('/webhooks/truelayer', { method: 'POST', ...w });
    expect(res.status).toBe(200);

    const payment = await app.request(`/v1/payments/${paymentId}`, {
      headers: makeAuth(guestA),
    });
    const pay = (await payment.json()) as { status: string };
    expect(pay.status).toBe('pending');
  });
});

describe('Session settlement', () => {
  beforeAll(async () => {
    await ensureBillsBucket();
  });

  it('settles the session when every non-self_paid participant succeeds', async () => {
    const { app, provider } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const guestB = `b-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA, guestB]);

    for (const payer of [guestA, guestB]) {
      const { providerPaymentId } = await initiate(app, sessionId, payer);
      const auth = webhook(provider, { providerPaymentId, type: 'authorized' });
      await app.request('/webhooks/truelayer', { method: 'POST', ...auth });
      const exec = webhook(provider, { providerPaymentId, type: 'executed' });
      await app.request('/webhooks/truelayer', { method: 'POST', ...exec });
    }

    const session = await app.request(`/v1/sessions/${sessionId}`, {
      headers: makeAuth(creator),
    });
    const body = (await session.json()) as { status: string };
    expect(body.status).toBe('settled');
  });

  it('stays in paying while at least one non-self_paid participant has not yet succeeded', async () => {
    const { app, provider } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const guestB = `b-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA, guestB]);

    const a = await initiate(app, sessionId, guestA);
    let w = webhook(provider, { providerPaymentId: a.providerPaymentId, type: 'authorized' });
    await app.request('/webhooks/truelayer', { method: 'POST', ...w });
    w = webhook(provider, { providerPaymentId: a.providerPaymentId, type: 'executed' });
    await app.request('/webhooks/truelayer', { method: 'POST', ...w });

    // guestB still unpaid
    const session = await app.request(`/v1/sessions/${sessionId}`, {
      headers: makeAuth(creator),
    });
    const body = (await session.json()) as { status: string };
    expect(body.status).toBe('paying');
  });

  it('failed payment can be retried (initiate again with a new key)', async () => {
    const { app, provider } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);

    const first = await initiate(app, sessionId, guestA);
    const fail = webhook(provider, { providerPaymentId: first.providerPaymentId, type: 'failed' });
    await app.request('/webhooks/truelayer', { method: 'POST', ...fail });

    const second = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guestA) },
    });
    expect(second.status).toBe(201);
  });
});
