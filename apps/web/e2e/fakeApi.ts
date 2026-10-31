/**
 * A tiny in-memory stand-in for the API, shared by every browser context
 * in a test so the lead and the guests see the same bill. It implements
 * only what the table flows touch: me, bill, session, claims, shares,
 * payments, close. Rules mirror the real services where the UI depends
 * on them (joining a full split adds a way; a share replaces unit claims).
 */
import type { BrowserContext, Route } from '@playwright/test';

export type User = { userId: string; displayName: string; email: string };
type Payment =
  | { status: 'unpaid' }
  | { status: 'self_paid' }
  | { status: 'pending'; paymentId: string; payerClaimedPaidAt?: string }
  | { status: 'succeeded'; paymentId: string; paidAt: string };
type Participant = { userId: string; displayName: string; claimedItemIds: string[]; sharedItemIds: string[]; payment: Payment; readyToLock: boolean };
type Share = { itemId: string; userIds: string[]; ways: number; activity: unknown[] };

export const SID = '0193ab12-7c4d-7e00-9a1b-2c3d4e5f6a7b';
export const BID = '0193ab12-0000-7e00-9a1b-2c3d4e5f6a7b';
export const CODE = 'K7Q2MX';

const item = (n: number, name: string, unitPricePence: number, quantity = 1) => ({
  itemId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name, unitPricePence, quantity, category: 'food',
});
export const items = [item(1, 'Olives', 425), item(2, 'Calamari', 2250), item(3, 'Lasagne', 1725), item(4, 'Negroni', 1050, 2)];
const subtotalPence = items.reduce((a, i) => a + i.unitPricePence * i.quantity, 0);
export const bill = {
  billId: BID, versionNumber: 1, creatorUserId: 'u-lead', currency: 'GBP', subtotalPence, taxPence: 0, serviceChargePence: 0, totalPence: subtotalPence, items,
  parsedFrom: { imageHash: 'a'.repeat(64), parser: 'gemini', parserVersion: 'v2', parsedAt: new Date().toISOString() },
  venue: { name: 'Gennaro', address: '12 King Street, Manchester' }, createdAt: new Date().toISOString(),
};

export const users = {
  lead: { userId: 'u-lead', displayName: 'Callum Davies', email: 'callum@example.com' },
  sam: { userId: 'u-sam', displayName: 'Sam Patel', email: 'sam@example.com' },
  tom: { userId: 'u-tom', displayName: 'Tom Reid', email: 'tom@example.com' },
} satisfies Record<string, User>;

export class FakeApi {
  status: 'claiming' | 'settled' | 'abandoned' = 'claiming';
  participants: Participant[] = [
    { userId: 'u-lead', displayName: 'Callum Davies', claimedItemIds: [items[0]!.itemId], sharedItemIds: [], payment: { status: 'self_paid' }, readyToLock: true },
  ];
  shares: Share[] = [];
  private paymentsByUser = new Map<string, string>();

  session() {
    return {
      sessionId: SID, status: this.status, creatorUserId: 'u-lead', collectorUserId: 'u-lead', billId: BID, pinnedBillVersion: 1, joinCode: CODE,
      venue: bill.venue, shares: this.shares, participants: this.participants, createdAt: bill.createdAt,
    };
  }

  private me(userId: string) {
    return this.participants.find((p) => p.userId === userId)!;
  }

  join(u: User) {
    if (!this.participants.some((p) => p.userId === u.userId)) {
      this.participants.push({ userId: u.userId, displayName: u.displayName, claimedItemIds: [], sharedItemIds: [], payment: { status: 'unpaid' }, readyToLock: false });
    }
  }

  /** Wire this fake into a browser context signed in as `user`. */
  async attach(ctx: BrowserContext, user: User) {
    this.join(user);
    await ctx.addInitScript(() => {
      localStorage.setItem('gdp.idToken', 'test-token');
      localStorage.setItem('gdp.lastActiveAt', String(Date.now()));
    });
    await ctx.route('**/v1/**', (route) => this.handle(route, user));
  }

  private handle(route: Route, user: User) {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const body = () => (req.postData() ? (JSON.parse(req.postData()!) as Record<string, unknown>) : {});
    const me = this.me(user.userId);

    if (path === '/v1/me') return json(user);
    if (path.startsWith('/v1/me/sessions')) return json({ sessions: [] });
    if (path === `/v1/bills/${BID}`) return json(bill);
    if (path === `/v1/bills/${BID}/image-url`) return json({ error: { code: 'IMAGE_UNAVAILABLE', message: 'n/a' } }, 404);
    if (path === '/v1/sessions/by-code') return json({ sessionId: SID });
    if (path === `/v1/sessions/${SID}/join`) { this.join(user); return json(this.session()); }
    if (path === `/v1/sessions/${SID}` && method === 'GET') return json(this.session());

    if (path === `/v1/sessions/${SID}/claims` && method === 'POST') {
      me.claimedItemIds = body().claimedItemIds as string[];
      return json(this.session());
    }
    if (path === `/v1/sessions/${SID}/shares` && method === 'POST') {
      const { itemId, ways } = body() as { itemId: string; ways?: number };
      const existing = this.shares.find((s) => s.itemId === itemId);
      if (existing) {
        if (!existing.userIds.includes(user.userId)) {
          existing.userIds.push(user.userId);
          existing.ways = Math.max(existing.ways, existing.userIds.length);
        }
      } else {
        this.shares.push({ itemId, userIds: [user.userId], ways: ways ?? 2, activity: [] });
      }
      me.claimedItemIds = me.claimedItemIds.filter((id) => id !== itemId);
      if (!me.sharedItemIds.includes(itemId)) me.sharedItemIds.push(itemId);
      return json(this.session());
    }
    const shareMatch = path.match(new RegExp(`^/v1/sessions/${SID}/shares/([^/]+)$`));
    if (shareMatch && method === 'DELETE') {
      const itemId = shareMatch[1]!;
      const sh = this.shares.find((s) => s.itemId === itemId);
      if (sh) sh.userIds = sh.userIds.filter((id) => id !== user.userId);
      me.sharedItemIds = me.sharedItemIds.filter((id) => id !== itemId);
      return json(this.session());
    }
    if (shareMatch && method === 'PUT') {
      const sh = this.shares.find((s) => s.itemId === shareMatch[1]);
      if (sh) sh.ways = body().ways as number;
      return json(this.session());
    }

    if (path === `/v1/sessions/${SID}/payments` && method === 'POST') {
      const paymentId = `pay-${user.userId}`;
      this.paymentsByUser.set(user.userId, paymentId);
      me.payment = { status: 'pending', paymentId };
      return json({
        payment: { paymentId, sessionId: SID, payerUserId: user.userId, amountPence: 1000, status: 'pending' },
        instructions: { type: 'manual_transfer', reference: 'gdp-0193ab12', amountPence: 1000, links: {}, bankDetails: { accountHolderName: 'Callum Davies', sortCode: '040668', accountNumber: '00079660' } },
      }, 201);
    }
    const payMatch = path.match(/^\/v1\/payments\/([^/]+)\/(mark-paid|confirm)$/);
    if (payMatch) {
      const [, paymentId, action] = payMatch;
      const payer = this.participants.find((p) => p.payment.status !== 'unpaid' && p.payment.status !== 'self_paid' && p.payment.paymentId === paymentId);
      if (!payer) return json({ error: { code: 'PAYMENT_NOT_FOUND', message: 'no' } }, 404);
      if (action === 'mark-paid' && payer.payment.status === 'pending') payer.payment = { ...payer.payment, payerClaimedPaidAt: new Date().toISOString() };
      if (action === 'confirm') payer.payment = { status: 'succeeded', paymentId: paymentId!, paidAt: new Date().toISOString() };
      // Deliberately no auto-settle: only the lead's close ends the bill.
      return json({ paymentId, sessionId: SID, payerUserId: payer.userId, amountPence: 1000, status: payer.payment.status });
    }

    if (path === `/v1/sessions/${SID}/close` && method === 'POST') {
      if (user.userId !== 'u-lead') return json({ error: { code: 'SESSION_NOT_FOUND', message: 'no' } }, 404);
      this.status = 'settled';
      return json(this.session());
    }
    return json({ error: { code: 'NOT_FOUND', message: `unhandled ${method} ${path}` } }, 404);
  }
}
