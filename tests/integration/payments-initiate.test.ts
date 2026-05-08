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
  const provider = new MockTrueLayerProvider('test-secret');
  const app = createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(sampleParsedBill),
    paymentProvider: provider,
  });
  return { app, provider };
};

describe('POST /v1/sessions/:id/payments', () => {
  beforeAll(async () => {
    await ensureBillsBucket();
  });

  it('initiates a payment for a participant in a paying session', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const guestB = `b-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA, guestB]);

    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: {
        'idempotency-key': newIdempotencyKey(),
        ...makeAuth(guestA),
      },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: {
        paymentId: string;
        sessionId: string;
        payerUserId: string;
        collectorUserId: string;
        amountPence: number;
        currency: string;
        provider: string;
        status: string;
      };
      providerRedirectUrl: string;
    };
    expect(body.payment.payerUserId).toBe(guestA);
    expect(body.payment.collectorUserId).toBe(creator);
    expect(body.payment.sessionId).toBe(sessionId);
    expect(body.payment.amountPence).toBeGreaterThan(0);
    expect(body.payment.currency).toBe('GBP');
    expect(body.payment.provider).toBe('truelayer');
    expect(body.payment.status).toBe('pending');
    expect(body.providerRedirectUrl).toMatch(/^https:\/\//);
  });

  it('after initiate, the session shows the participant as payment.pending with the paymentId', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);

    const initiate = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guestA) },
    });
    const initiated = (await initiate.json()) as { payment: { paymentId: string } };

    const session = await app.request(`/v1/sessions/${sessionId}`, {
      headers: makeAuth(creator),
    });
    const body = (await session.json()) as {
      participants: { userId: string; payment: { status: string; paymentId?: string } }[];
    };
    const part = body.participants.find((p) => p.userId === guestA);
    expect(part?.payment.status).toBe('pending');
    expect(part?.payment.paymentId).toBe(initiated.payment.paymentId);
  });

  it('rejects when caller is not a participant', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const stranger = `s-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);

    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(stranger) },
    });
    expect(res.status).toBe(404);
  });

  it('rejects when the collector tries to pay themselves', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);

    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(creator) },
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_INVALID_STATE');
  });

  it('rejects when the session is not in paying', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);

    // Abandon to leave paying state
    await app.request(`/v1/sessions/${sessionId}/abandon`, {
      method: 'POST',
      headers: makeAuth(creator),
    });

    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guestA) },
    });
    expect(res.status).toBe(409);
  });

  it('requires Idempotency-Key header (400 INVALID_INPUT)', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);

    const res = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: makeAuth(guestA),
    });
    expect(res.status).toBe(400);
  });

  it('replays the cached response on a duplicate Idempotency-Key', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);
    const key = newIdempotencyKey();

    const first = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': key, ...makeAuth(guestA) },
    });
    const firstBody = (await first.json()) as { payment: { paymentId: string } };

    const second = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': key, ...makeAuth(guestA) },
    });
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    const secondBody = (await second.json()) as { payment: { paymentId: string } };
    expect(secondBody.payment.paymentId).toBe(firstBody.payment.paymentId);
  });

  it('IDEMPOTENCY_CONFLICT when the same key is used against a different session', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const a1 = await buildPayingSession(app, creator, [guestA]);
    const a2 = await buildPayingSession(app, creator, [guestA]);
    const key = newIdempotencyKey();

    await app.request(`/v1/sessions/${a1.sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': key, ...makeAuth(guestA) },
    });
    const conflict = await app.request(`/v1/sessions/${a2.sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': key, ...makeAuth(guestA) },
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string } };
    expect(body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});

describe('GET /v1/payments/:id', () => {
  beforeAll(async () => {
    await ensureBillsBucket();
  });

  it('payer can read their own payment', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);

    const initiate = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guestA) },
    });
    const created = (await initiate.json()) as { payment: { paymentId: string } };

    const get = await app.request(`/v1/payments/${created.payment.paymentId}`, {
      headers: makeAuth(guestA),
    });
    expect(get.status).toBe(200);
  });

  it('collector can read any payment in their session', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);

    const initiate = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guestA) },
    });
    const created = (await initiate.json()) as { payment: { paymentId: string } };

    const get = await app.request(`/v1/payments/${created.payment.paymentId}`, {
      headers: makeAuth(creator),
    });
    expect(get.status).toBe(200);
  });

  it('strangers get 404 even if they know the paymentId', async () => {
    const { app } = buildApp();
    const creator = `c-${uuidv7()}`;
    const guestA = `a-${uuidv7()}`;
    const stranger = `s-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guestA]);

    const initiate = await app.request(`/v1/sessions/${sessionId}/payments`, {
      method: 'POST',
      headers: { 'idempotency-key': newIdempotencyKey(), ...makeAuth(guestA) },
    });
    const created = (await initiate.json()) as { payment: { paymentId: string } };

    const get = await app.request(`/v1/payments/${created.payment.paymentId}`, {
      headers: makeAuth(stranger),
    });
    expect(get.status).toBe(404);
  });
});
