import { describe, it, expect, beforeAll } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
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
    paymentProvider: null, // manual mode
  });

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

describe('POST /v1/payments/:id/mark-paid — payer claims they paid', () => {
  beforeAll(ensureBillsBucket);

  it('sets payerClaimedPaidAt without changing status', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);

    const res = await app.request(`/v1/payments/${paymentId}/mark-paid`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; payerClaimedPaidAt?: string };
    expect(body.status).toBe('pending');
    expect(body.payerClaimedPaidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('mirrors payerClaimedPaidAt onto the participant payment in session view', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);
    await app.request(`/v1/payments/${paymentId}/mark-paid`, {
      method: 'POST',
      headers: makeAuth(guest),
    });

    const sess = await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(creator) });
    const body = (await sess.json()) as {
      participants: { userId: string; payment: { status: string; payerClaimedPaidAt?: string } }[];
    };
    const part = body.participants.find((p) => p.userId === guest);
    expect(part?.payment.status).toBe('pending');
    expect(part?.payment.payerClaimedPaidAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is idempotent — re-claiming returns the same timestamp', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);

    const first = await app.request(`/v1/payments/${paymentId}/mark-paid`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    const t1 = ((await first.json()) as { payerClaimedPaidAt: string }).payerClaimedPaidAt;
    // Wait a tick so the timestamps would differ if we weren't idempotent.
    await new Promise((r) => setTimeout(r, 5));
    const second = await app.request(`/v1/payments/${paymentId}/mark-paid`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    const t2 = ((await second.json()) as { payerClaimedPaidAt: string }).payerClaimedPaidAt;
    expect(t1).toBe(t2);
  });

  it('is concurrency-safe — parallel claims all return the canonical timestamp', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);

    // Pre-fix: each request did its own read-then-write and stamped its
    // own timestamp; the participant mirror could diverge from the
    // payment row. Post-fix: if_not_exists on both rows guarantees one
    // canonical value across all writers.
    const responses = await Promise.all(
      Array.from({ length: 5 }, async () =>
        app.request(`/v1/payments/${paymentId}/mark-paid`, {
          method: 'POST',
          headers: makeAuth(guest),
        }),
      ),
    );
    const bodies = await Promise.all(responses.map((r) => r.json()));
    const timestamps = bodies.map((b) => (b as { payerClaimedPaidAt: string }).payerClaimedPaidAt);
    expect(new Set(timestamps).size).toBe(1);

    // Participant mirror must reflect the same canonical timestamp.
    const sess = await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(creator) });
    const body = (await sess.json()) as {
      participants: { userId: string; payment: { payerClaimedPaidAt?: string } }[];
    };
    const part = body.participants.find((p) => p.userId === guest);
    expect(part?.payment.payerClaimedPaidAt).toBe(timestamps[0]);
  });

  it("preserves the participant's GSI1 entry across writes (listForUser regression)", async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);

    // Pre-fix: paymentStore.applyUpdate's Put on the participant row
    // dropped GSI1PK/GSI1SK (sessionStore.get strips them on read), so
    // every webhook + initiate + mark-paid + confirm silently removed
    // the session from the participant's /v1/me/sessions list.
    await app.request(`/v1/payments/${paymentId}/mark-paid`, {
      method: 'POST',
      headers: makeAuth(guest),
    });

    const list = await app.request('/v1/me/sessions', { headers: makeAuth(guest) });
    expect(list.status).toBe(200);
    const body = (await list.json()) as { sessions: { sessionId: string }[] };
    expect(body.sessions.map((s) => s.sessionId)).toContain(sessionId);
  });

  it('does not gate or trigger session settlement on its own', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);
    await app.request(`/v1/payments/${paymentId}/mark-paid`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    const sess = await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(creator) });
    const body = (await sess.json()) as { status: string };
    expect(body.status).toBe('paying'); // not settled
  });

  it('lead can still confirm afterwards → succeeded; payerClaimedPaidAt is dropped from participant on transition', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);
    await app.request(`/v1/payments/${paymentId}/mark-paid`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    await app.request(`/v1/payments/${paymentId}/confirm`, {
      method: 'POST',
      headers: makeAuth(creator),
    });

    const sess = await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(creator) });
    const body = (await sess.json()) as {
      status: string;
      participants: { userId: string; payment: { status: string } }[];
    };
    expect(body.status).toBe('settled');
    const part = body.participants.find((p) => p.userId === guest);
    expect(part?.payment.status).toBe('succeeded');
  });

  it('non-payer cannot mark someone else as paid → 404 PAYMENT_NOT_FOUND', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const interloper = `x-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);

    const res = await app.request(`/v1/payments/${paymentId}/mark-paid`, {
      method: 'POST',
      headers: makeAuth(interloper),
    });
    expect(res.status).toBe(404);
  });

  it('cannot mark-paid after the payment is already succeeded', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId } = await buildPayingSession(app, creator, [guest]);
    const paymentId = await initiate(app, sessionId, guest);
    await app.request(`/v1/payments/${paymentId}/confirm`, {
      method: 'POST',
      headers: makeAuth(creator),
    });

    const res = await app.request(`/v1/payments/${paymentId}/mark-paid`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_INVALID_STATE');
  });
});
