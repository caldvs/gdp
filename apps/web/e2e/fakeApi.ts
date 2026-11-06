/**
 * The in-memory API (fakeCore.ts) wired into Playwright: one FakeApi is
 * shared by every browser context in a test, so the lead and the guests
 * see the same bill.
 */
import { pbkdf2Sync } from 'node:crypto';
import type { BrowserContext, Route } from '@playwright/test';
import { FakeCore, LEAD_BANK, SID, type User } from './fakeCore';

export * from './fakeCore';

export class FakeApi extends FakeCore {
  /** Wire this fake into a browser context signed in as `user`. */
  /** `atTable: false` signs the user in without seating them (a newcomer). */
  async attach(ctx: BrowserContext, user: User, opts: { signedIn?: boolean; lastActiveAgoMs?: number; atTable?: boolean } = {}) {
    const signedIn = opts.signedIn ?? true;
    if (signedIn) { if (opts.atTable !== false) this.join(user); this.signedIn.add(user.userId); }
    await ctx.addInitScript(({ signedIn, ago }) => {
      if (signedIn) {
        localStorage.setItem('gdp.idToken', 'test-token');
        localStorage.setItem('gdp.lastActiveAt', String(Date.now() - ago));
      }
    }, { signedIn, ago: opts.lastActiveAgoMs ?? 0 });
    await ctx.route('**/v1/**', (route) => this.fulfil(route, user));
  }

  private fulfil(route: Route, user: User) {
    const req = route.request();
    return route.fulfill(this.respond({
      method: req.method(),
      path: new URL(req.url()).pathname,
      body: req.postData(),
      authorization: req.headers()['authorization'],
    }, user));
  }
}

/** What the lead's device sends for these details (#151): same sum as core's payoutCheck.ts. */
export function payoutCheckFor(account: { accountHolderName: string; sortCode: string; accountNumber: string; monzoHandle?: string; revolutTag?: string } = LEAD_BANK): string {
  const password = JSON.stringify([account.accountHolderName.trim(), account.sortCode, account.accountNumber, account.monzoHandle ?? '', account.revolutTag ?? '']);
  return pbkdf2Sync(password, `gdp-payout-check:${SID}`, 100_000, 32, 'sha256').toString('hex');
}

/** The lead's bank details as the join link carries them (ADR-0002). */
export function fragmentFor(opts: { ageMs?: number; ttlMs?: number; monzo?: string; revolut?: string } = {}): string {
  const now = Date.now() - (opts.ageMs ?? 0);
  const payload = {
    v: 1, n: LEAD_BANK.accountHolderName, s: LEAD_BANK.sortCode, a: LEAD_BANK.accountNumber, iat: Math.floor(now / 1000),
    ...(opts.monzo ? { m: opts.monzo } : {}), ...(opts.revolut ? { r: opts.revolut } : {}),
    ...(opts.ttlMs !== undefined ? { x: Math.floor((now + opts.ttlMs) / 1000) } : {}),
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
