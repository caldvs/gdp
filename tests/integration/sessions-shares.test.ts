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
} from './helpers.js';
import type { Session } from '../../src/types/sessions.js';
import type { ParsedBillFromImage } from '../../src/services/bills/parser.js';

const buildApp = (parsed: ParsedBillFromImage = sampleParsedBill) =>
  createApp({
    idTokenVerifier: fakeVerifier,
    billParser: new FixtureBillParser(parsed),
  });

async function setUpSessionForSharing(
  app: ReturnType<typeof buildApp>,
  creator: string,
): Promise<{ sessionId: string; itemIds: string[] }> {
  const bill = await createBillFor(app, creator);
  const create = await app.request('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(creator) },
    body: JSON.stringify({ billId: bill.billId }),
  });
  const created = (await create.json()) as { sessionId: string };
  return {
    sessionId: created.sessionId,
    itemIds: bill.items.map((it) => it.itemId),
  };
}

async function shareItem(
  app: ReturnType<typeof buildApp>,
  user: string,
  sessionId: string,
  itemId: string,
): Promise<Response> {
  return app.request(`/v1/sessions/${sessionId}/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(user) },
    body: JSON.stringify({ itemId }),
  });
}

async function unshareItem(
  app: ReturnType<typeof buildApp>,
  user: string,
  sessionId: string,
  itemId: string,
): Promise<Response> {
  return app.request(`/v1/sessions/${sessionId}/shares/${itemId}`, {
    method: 'DELETE',
    headers: makeAuth(user),
  });
}

describe('shares — ADR-0006', () => {
  beforeAll(ensureBillsBucket);

  it('POST /shares puts the caller into the splitter set; shares appears on the session response', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, itemIds } = await setUpSessionForSharing(app, creator);

    const res = await shareItem(app, creator, sessionId, itemIds[0]!);
    expect(res.status).toBe(200);
    const session = (await res.json()) as Session;
    expect(session.shares).toEqual([{ itemId: itemIds[0], userIds: [creator] }]);
    const me = session.participants.find((p) => p.userId === creator);
    expect(me?.sharedItemIds).toEqual([itemIds[0]]);
  });

  it('POST /shares is idempotent — re-adding does not duplicate', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, itemIds } = await setUpSessionForSharing(app, creator);

    await shareItem(app, creator, sessionId, itemIds[0]!);
    const second = await shareItem(app, creator, sessionId, itemIds[0]!);
    expect(second.status).toBe(200);
    const session = (await second.json()) as Session;
    const me = session.participants.find((p) => p.userId === creator);
    expect(me?.sharedItemIds).toEqual([itemIds[0]]);
    expect(session.shares).toHaveLength(1);
  });

  it('two diners sharing the same item both appear in the splitter set', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, itemIds } = await setUpSessionForSharing(app, creator);
    // Creator shares -> transitions session to setup with a share. Need to
    // share, then advance to claiming so a guest can join.
    await shareItem(app, creator, sessionId, itemIds[0]!);
    await app.request(`/v1/sessions/${sessionId}/share`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    const guest = `g-${uuidv7()}`;
    await app.request(`/v1/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(guest),
    });
    const res = await shareItem(app, guest, sessionId, itemIds[0]!);
    expect(res.status).toBe(200);
    const session = (await res.json()) as Session;
    const share = session.shares?.find((s) => s.itemId === itemIds[0]);
    expect(share?.userIds.sort()).toEqual([creator, guest].sort());
  });

  it('DELETE /shares/:itemId removes the caller; idempotent when absent', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, itemIds } = await setUpSessionForSharing(app, creator);
    await shareItem(app, creator, sessionId, itemIds[0]!);

    const leave = await unshareItem(app, creator, sessionId, itemIds[0]!);
    expect(leave.status).toBe(200);
    const session = (await leave.json()) as Session;
    expect(session.shares ?? []).toEqual([]);
    expect(session.participants.find((p) => p.userId === creator)?.sharedItemIds).toEqual([]);

    // Repeating is a no-op.
    const again = await unshareItem(app, creator, sessionId, itemIds[0]!);
    expect(again.status).toBe(200);
  });

  it('returns 409 ITEM_NOT_SHAREABLE for an item with quantity > 1', async () => {
    const app = buildApp({
      ...sampleParsedBill,
      items: [
        { name: 'Two Pints', unitPricePence: 650, quantity: 2, category: 'drink' },
        ...sampleParsedBill.items.slice(1),
      ],
    });
    const creator = `c-${uuidv7()}`;
    const { sessionId, itemIds } = await setUpSessionForSharing(app, creator);
    // itemIds[0] is the quantity-2 item.
    const res = await shareItem(app, creator, sessionId, itemIds[0]!);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('ITEM_NOT_SHAREABLE');
  });

  it('returns 409 CLAIM_SHARE_CONFLICT if the item is already claimed', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, itemIds } = await setUpSessionForSharing(app, creator);
    // Creator claims it first.
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ claimedItemIds: [itemIds[0]!] }),
    });
    const res = await shareItem(app, creator, sessionId, itemIds[0]!);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CLAIM_SHARE_CONFLICT');
  });

  it('returns 409 CLAIM_SHARE_CONFLICT if a claim is attempted on a shared item', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, itemIds } = await setUpSessionForSharing(app, creator);
    await shareItem(app, creator, sessionId, itemIds[0]!);

    const res = await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ claimedItemIds: [itemIds[0]!] }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CLAIM_SHARE_CONFLICT');
  });

  it('refuses POST /shares when session is past claiming (e.g. paying)', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const { sessionId, itemIds } = await setUpSessionForSharing(app, creator);
    // Claim every item to satisfy lock-claims, then lock.
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ claimedItemIds: itemIds }),
    });
    await app.request(`/v1/sessions/${sessionId}/share`, {
      method: 'POST',
      headers: makeAuth(creator),
    });
    const lockRes = await app.request(`/v1/sessions/${sessionId}/lock-claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ force: true }),
    });
    expect(lockRes.status).toBe(200);

    const denied = await shareItem(app, creator, sessionId, itemIds[0]!);
    expect(denied.status).toBe(409);
    const body = (await denied.json()) as { error: { code: string } };
    expect(body.error.code).toBe('SESSION_INVALID_STATE');
  });
});
