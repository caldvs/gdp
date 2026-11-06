import { describe, it, expect, beforeAll } from 'vitest';
import { uuidv7 } from '../../src/lib/uuid.js';
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
    expect(session.shares).toEqual([
      {
        itemId: itemIds[0],
        userIds: [creator],
        ways: 2,
        units: 1,
        activity: [expect.objectContaining({ kind: 'started', byUserId: creator, toWays: 2 })],
      },
    ]);
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

  it('returns 409 CLAIM_SHARE_CONFLICT if the caller has claimed the item themselves', async () => {
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

// ---------------------------------------------------------------------------
// Number of ways (how many people shared the item)
// ---------------------------------------------------------------------------

async function openWithGuests(app: ReturnType<typeof buildApp>, creator: string, guests: string[]) {
  const { sessionId, itemIds } = await setUpSessionForSharing(app, creator);
  await app.request(`/v1/sessions/${sessionId}/share`, {
    method: 'POST',
    headers: makeAuth(creator),
  });
  for (const g of guests) {
    await app.request(`/v1/sessions/${sessionId}/join`, { method: 'POST', headers: makeAuth(g) });
  }
  return { sessionId, itemIds };
}

async function startSplit(
  app: ReturnType<typeof buildApp>,
  user: string,
  sessionId: string,
  itemId: string,
  ways: number,
) {
  return app.request(`/v1/sessions/${sessionId}/shares`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...makeAuth(user) },
    body: JSON.stringify({ itemId, ways }),
  });
}

async function setWays(
  app: ReturnType<typeof buildApp>,
  user: string,
  sessionId: string,
  itemId: string,
  ways: number,
) {
  return app.request(`/v1/sessions/${sessionId}/shares/${itemId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...makeAuth(user) },
    body: JSON.stringify({ ways }),
  });
}

const shareOf = (s: Session, itemId: string) => s.shares?.find((x) => x.itemId === itemId);

describe('shares — number of ways', () => {
  beforeAll(ensureBillsBucket);

  it('the starter sets the number of ways; joining takes an open spot without changing it', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const g1 = `g1-${uuidv7()}`;
    const { sessionId, itemIds } = await openWithGuests(app, creator, [g1]);
    const itemId = itemIds[0]!;

    const started = (await (await startSplit(app, g1, sessionId, itemId, 3)).json()) as Session;
    expect(shareOf(started, itemId)).toMatchObject({ userIds: [g1], ways: 3 });

    const joined = (await (await shareItem(app, creator, sessionId, itemId)).json()) as Session;
    expect(shareOf(joined, itemId)?.ways).toBe(3);
    expect(shareOf(joined, itemId)?.activity.at(-1)).toMatchObject({
      kind: 'joined',
      byUserId: creator,
    });
    expect(shareOf(joined, itemId)?.activity.at(-1)?.toWays).toBeUndefined();
  });

  it('joining a split where every spot is taken makes it one more way', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const g1 = `g1-${uuidv7()}`;
    const g2 = `g2-${uuidv7()}`;
    const { sessionId, itemIds } = await openWithGuests(app, creator, [g1, g2]);
    const itemId = itemIds[0]!;
    await startSplit(app, g1, sessionId, itemId, 2);
    await shareItem(app, g2, sessionId, itemId);
    const res = await shareItem(app, creator, sessionId, itemId);
    const share = shareOf((await res.json()) as Session, itemId);
    expect(share?.ways).toBe(3);
    expect(share?.activity.at(-1)).toMatchObject({
      kind: 'joined',
      byUserId: creator,
      fromWays: 2,
      toWays: 3,
    });
  });

  it('someone in the split can change the number of ways; it is recorded as activity', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const g1 = `g1-${uuidv7()}`;
    const { sessionId, itemIds } = await openWithGuests(app, creator, [g1]);
    const itemId = itemIds[0]!;
    await startSplit(app, g1, sessionId, itemId, 3);
    await shareItem(app, creator, sessionId, itemId);

    const res = await setWays(app, creator, sessionId, itemId, 2);
    expect(res.status).toBe(200);
    const share = shareOf((await res.json()) as Session, itemId);
    expect(share?.ways).toBe(2);
    expect(share?.activity.at(-1)).toMatchObject({
      kind: 'ways',
      byUserId: creator,
      fromWays: 3,
      toWays: 2,
    });

    // Everyone sees it on a fresh read.
    const fresh = (await (
      await app.request(`/v1/sessions/${sessionId}`, { headers: makeAuth(g1) })
    ).json()) as Session;
    expect(shareOf(fresh, itemId)?.ways).toBe(2);
    expect((fresh as Session & { shareSettings?: unknown }).shareSettings).toBeUndefined();
  });

  it('only people in the split can change it, and not below the number already in it', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const g1 = `g1-${uuidv7()}`;
    const g2 = `g2-${uuidv7()}`;
    const { sessionId, itemIds } = await openWithGuests(app, creator, [g1, g2]);
    const itemId = itemIds[0]!;
    await startSplit(app, g1, sessionId, itemId, 4);
    await shareItem(app, g2, sessionId, itemId);
    await shareItem(app, creator, sessionId, itemId);

    const outsider = `g3-${uuidv7()}`;
    await app.request(`/v1/sessions/${sessionId}/join`, {
      method: 'POST',
      headers: makeAuth(outsider),
    });
    const notIn = await setWays(app, outsider, sessionId, itemId, 2);
    expect(notIn.status).toBe(409);
    expect(((await notIn.json()) as { error: { code: string } }).error.code).toBe('SHARE_CONFLICT');

    const tooLow = await setWays(app, g1, sessionId, itemId, 2);
    expect(tooLow.status).toBe(409);
    expect(((await tooLow.json()) as { error: { code: string } }).error.code).toBe(
      'SHARE_WAYS_TOO_LOW',
    );
  });

  it('leaving keeps the number of ways (the spot reopens); the last one out removes the split', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const g1 = `g1-${uuidv7()}`;
    const { sessionId, itemIds } = await openWithGuests(app, creator, [g1]);
    const itemId = itemIds[0]!;
    await startSplit(app, g1, sessionId, itemId, 3);
    await shareItem(app, creator, sessionId, itemId);

    const left = (await (await unshareItem(app, creator, sessionId, itemId)).json()) as Session;
    expect(shareOf(left, itemId)).toMatchObject({ userIds: [g1], ways: 3 });
    expect(shareOf(left, itemId)?.activity.at(-1)).toMatchObject({
      kind: 'left',
      byUserId: creator,
    });

    const gone = (await (await unshareItem(app, g1, sessionId, itemId)).json()) as Session;
    expect(shareOf(gone, itemId)).toBeUndefined();

    // Starting again later begins fresh with the new starter's number.
    const again = (await (await startSplit(app, creator, sessionId, itemId, 2)).json()) as Session;
    expect(shareOf(again, itemId)).toMatchObject({ userIds: [creator], ways: 2 });
    expect(shareOf(again, itemId)?.activity).toHaveLength(1);
  });

  it('lock-claims treats open spots as unclaimed and charges each sharer price / ways', async () => {
    const app = buildApp();
    const creator = `c-${uuidv7()}`;
    const g1 = `g1-${uuidv7()}`;
    const { sessionId, itemIds } = await openWithGuests(app, creator, [g1]);
    const [shared, ...rest] = itemIds;
    await startSplit(app, g1, sessionId, shared!, 3);
    await shareItem(app, creator, sessionId, shared!);
    await app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(creator) },
      body: JSON.stringify({ claimedItemIds: rest }),
    });
    const lock = () =>
      app.request(`/v1/sessions/${sessionId}/lock-claims`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...makeAuth(creator) },
        body: JSON.stringify({ force: true }),
      });

    const incomplete = await lock();
    expect(incomplete.status).toBe(409);
    expect(
      ((await incomplete.json()) as { error: { details: { unclaimedItemIds: string[] } } }).error
        .details.unclaimedItemIds,
    ).toEqual([shared]);

    await setWays(app, g1, sessionId, shared!, 2);
    const ok = await lock();
    expect(ok.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Splitting some of a line with more than one of something
// ---------------------------------------------------------------------------

describe('splits on a multi-quantity line', () => {
  const threeBottles = buildApp.bind(null, {
    ...sampleParsedBill,
    items: [
      { name: 'Rioja bottle', unitPricePence: 2400, quantity: 3, category: 'drink' },
      ...sampleParsedBill.items.slice(1),
    ],
  });
  const claim = (
    app: ReturnType<typeof buildApp>,
    user: string,
    sessionId: string,
    ids: string[],
  ) =>
    app.request(`/v1/sessions/${sessionId}/claims`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(user) },
      body: JSON.stringify({ claimedItemIds: ids }),
    });
  const split = (
    app: ReturnType<typeof buildApp>,
    user: string,
    sessionId: string,
    body: Record<string, unknown>,
  ) =>
    app.request(`/v1/sessions/${sessionId}/shares`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...makeAuth(user) },
      body: JSON.stringify(body),
    });

  it('covers every unit nobody has claimed by default, and they can’t then be claimed', async () => {
    const app = threeBottles();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId, itemIds } = await openWithGuests(app, creator, [guest]);
    const wine = itemIds[0]!;
    expect((await claim(app, guest, sessionId, [wine])).status).toBe(200);

    const res = await split(app, creator, sessionId, { itemId: wine, ways: 2 });
    expect(res.status).toBe(200);
    const session = (await res.json()) as Session;
    expect(shareOf(session, wine)).toMatchObject({ ways: 2, units: 2, userIds: [creator] });
    // The guest keeps their own bottle alongside the split.
    expect(session.participants.find((p) => p.userId === guest)?.claimedItemIds).toEqual([wine]);

    const more = await claim(app, guest, sessionId, [wine, wine]);
    expect(more.status).toBe(409);
    expect(((await more.json()) as { error: { code: string } }).error.code).toBe(
      'SESSION_INVALID_STATE',
    );

    // Joining takes the open spot: £48 two ways.
    const joined = (await (await split(app, guest, sessionId, { itemId: wine })).json()) as Session;
    expect(shareOf(joined, wine)).toMatchObject({ ways: 2, units: 2 });
    expect(joined.participants.find((p) => p.userId === guest)?.claimedItemIds).toEqual([wine]);
  });

  it('takes just `units`, leaves the rest to claim, and refuses more than is left', async () => {
    const app = threeBottles();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId, itemIds } = await openWithGuests(app, creator, [guest]);
    const wine = itemIds[0]!;

    const tooMany = await split(app, creator, sessionId, { itemId: wine, units: 4 });
    expect(tooMany.status).toBe(409);
    expect(((await tooMany.json()) as { error: { code: string } }).error.code).toBe(
      'SESSION_INVALID_STATE',
    );

    const res = await split(app, creator, sessionId, { itemId: wine, units: 1, ways: 3 });
    expect(shareOf((await res.json()) as Session, wine)).toMatchObject({ units: 1, ways: 3 });
    expect((await claim(app, guest, sessionId, [wine, wine])).status).toBe(200);
    expect((await claim(app, creator, sessionId, [wine])).status).toBe(409);
  });

  it('keeps its units when someone leaves or the ways change', async () => {
    const app = threeBottles();
    const creator = `c-${uuidv7()}`;
    const guest = `g-${uuidv7()}`;
    const { sessionId, itemIds } = await openWithGuests(app, creator, [guest]);
    const wine = itemIds[0]!;
    await split(app, creator, sessionId, { itemId: wine, units: 2, ways: 2 });
    await split(app, guest, sessionId, { itemId: wine });

    const wider = (await (await setWays(app, guest, sessionId, wine, 3)).json()) as Session;
    expect(shareOf(wider, wine)).toMatchObject({ units: 2, ways: 3 });
    const left = (await (await unshareItem(app, guest, sessionId, wine)).json()) as Session;
    expect(shareOf(left, wine)).toMatchObject({ units: 2, ways: 3, userIds: [creator] });
  });
});
