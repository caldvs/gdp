import { describe, it, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../../src/app.js';
import { fakeVerifier, makeAuth } from './helpers.js';

const app = createApp({ idTokenVerifier: fakeVerifier });

const validBody = {
  sortCode: '040668',
  accountNumber: '00079660',
  accountHolderName: 'Callum Davies',
};

describe('PUT /v1/me/payout-account', () => {
  it('rejects unauth', async () => {
    const res = await app.request('/v1/me/payout-account', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validBody),
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 echoing the body but does NOT persist (deprecated per ADR-0002)', async () => {
    const userId = `u-${uuidv7()}`;

    // First /me — no payoutAccount.
    const before = await app.request('/v1/me', { headers: makeAuth(userId) });
    expect(before.status).toBe(200);
    expect(await before.json()).not.toHaveProperty('payoutAccount');

    // PUT — accepted but ignored.
    const put = await app.request('/v1/me/payout-account', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify(validBody),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ payoutAccount: validBody });

    // /me must still NOT have a payoutAccount — the write was a no-op.
    const after = await app.request('/v1/me', { headers: makeAuth(userId) });
    const body = (await after.json()) as { payoutAccount?: typeof validBody };
    expect(body.payoutAccount).toBeUndefined();
  });

  it('subsequent PUTs continue to be no-ops (no persistence across calls)', async () => {
    const userId = `u-${uuidv7()}`;
    await app.request('/v1/me/payout-account', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify(validBody),
    });
    const newAcct = { ...validBody, accountNumber: '12345678', accountHolderName: 'Other Name' };
    const second = await app.request('/v1/me/payout-account', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify(newAcct),
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ payoutAccount: newAcct });

    const after = await app.request('/v1/me', { headers: makeAuth(userId) });
    const body = (await after.json()) as { payoutAccount?: typeof validBody };
    expect(body.payoutAccount).toBeUndefined();
  });

  it.each([
    [{ ...validBody, sortCode: '04-06-68' }, 'sortCode'],
    [{ ...validBody, sortCode: '12345' }, 'sortCode'],
    [{ ...validBody, accountNumber: '0007966' }, 'accountNumber'],
    [{ ...validBody, accountNumber: '000796601' }, 'accountNumber'],
    [{ ...validBody, accountHolderName: '' }, 'accountHolderName'],
    [{ ...validBody, accountHolderName: 'a'.repeat(151) }, 'accountHolderName'],
  ])('400 for %#: invalid %s', async (body, _label) => {
    const userId = `u-${uuidv7()}`;
    const res = await app.request('/v1/me/payout-account', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    const errBody = (await res.json()) as { error: { code: string } };
    expect(errBody.error.code).toBe('INVALID_INPUT');
  });

  it('400 for non-JSON body', async () => {
    const userId = `u-${uuidv7()}`;
    const res = await app.request('/v1/me/payout-account', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...makeAuth(userId) },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});
