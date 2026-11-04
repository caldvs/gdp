/**
 * A tiny in-memory stand-in for the API, shared by every browser context
 * in a test so the lead and the guests see the same bill. It implements
 * what the flows touch: auth, me, uploads/parse, bill + amend, session,
 * claims, shares, payments, close/abandon. Rules mirror the real services
 * where the UI depends on them (joining a full split adds a way; a share
 * replaces unit claims; the last unit can't be claimed twice; claims are
 * frozen once the guest has said they've paid).
 */
import { pbkdf2Sync } from 'node:crypto';
import type { BrowserContext, Route } from '@playwright/test';

export type User = { userId: string; displayName: string; email: string };
type Payment =
  | { status: 'unpaid' }
  | { status: 'self_paid' }
  | { status: 'pending'; paymentId: string; payerClaimedPaidAt?: string }
  | { status: 'succeeded'; paymentId: string; paidAt: string }
  | { status: 'failed'; paymentId: string; reason: string };
type Entry = { paymentId: string; amountPence: number; status: 'pending' | 'succeeded' | 'failed'; payerClaimedPaidAt?: string; paidAt?: string };
type Participant = { userId: string; displayName: string; claimedItemIds: string[]; sharedItemIds: string[]; payment: Payment; payments?: Entry[]; readyToLock: boolean };

/** #121: the participant's `payment` is the latest state across their payments. */
function aggregate(entries: Entry[]): Payment {
  const pending = [...entries].reverse().find((e) => e.status === 'pending');
  if (pending) return { status: 'pending', paymentId: pending.paymentId, ...(pending.payerClaimedPaidAt ? { payerClaimedPaidAt: pending.payerClaimedPaidAt } : {}) };
  const paid = [...entries].reverse().find((e) => e.status === 'succeeded');
  if (paid) return { status: 'succeeded', paymentId: paid.paymentId, paidAt: paid.paidAt! };
  return { status: 'unpaid' };
}
type Share = { itemId: string; userIds: string[]; ways: number; /** How many of the line (1 when absent). */ units?: number; activity: unknown[] };
type Item = { itemId: string; name: string; unitPricePence: number; quantity: number; category: string };

export const SID = '0193ab12-7c4d-7e00-9a1b-2c3d4e5f6a7b';
export const BID = '0193ab12-0000-7e00-9a1b-2c3d4e5f6a7b';
export const CODE = 'K7Q2MX';
/** What the fake /email/start hands the asking tab, and the code it emails. */
export const SIGN_IN_REQUEST = 'req.waiting-tab-secret';
export const SIGN_IN_CODE = '482913';
export const LEAD_BANK = { accountHolderName: 'Callum Davies', sortCode: '040668', accountNumber: '00079660' };

export const item = (n: number, name: string, unitPricePence: number, quantity = 1): Item => ({
  itemId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name, unitPricePence, quantity, category: 'food',
});
export const items: Item[] = [item(1, 'Olives', 425), item(2, 'Calamari', 2250), item(3, 'Lasagne', 1725), item(4, 'Negroni', 1050, 2), item(5, 'Espresso Martini', 1300, 3)];

export const users = {
  lead: { userId: 'u-lead', displayName: 'Callum Davies', email: 'callum@example.com' },
  sam: { userId: 'u-sam', displayName: 'Sam Patel', email: 'sam@example.com' },
  tom: { userId: 'u-tom', displayName: 'Tom Reid', email: 'tom@example.com' },
  priya: { userId: 'u-priya', displayName: 'Priya Shah', email: 'priya@example.com' },
} satisfies Record<string, User>;

export type Fault =
  | { kind: 'session-get-500'; times: number }
  | { kind: 'initiate-500'; times: number }
  | { kind: 'parse'; code: 'PARSE_FAILED' | 'IMAGE_TOO_LARGE' | 'PARSE_LOW_CONFIDENCE' | 'PARSE_TIMEOUT' | 'INTERNAL_ERROR'; message: string; details?: Record<string, unknown> };

export class FakeApi {
  status: 'setup' | 'claiming' | 'settled' | 'abandoned';
  items: Item[];
  serviceChargePence: number;
  participants: Participant[];
  shares: Share[] = [];
  /** Who asked to be emailed a report, in order. */
  reportsTo: string[] = [];
  faults: Fault[] = [];
  /** How many polls a background read stays `reading` before it finishes. */
  readPolls = 0;
  /** Set to hold every read at `reading` until it's cleared. */
  holdReads = false;
  private reads = new Map<string, { polls: number; error?: { code: string; message: string; details?: Record<string, unknown> } }>();
  /** Requests the app made, for assertions like "the fragment never left the browser". */
  requests: { method: string; path: string; body: string | null }[] = [];
  /** Users who have signed in with the emailed code (and so pass /v1/me). */
  private signedIn = new Set<string>();
  /** #183: the name a guest joined with, by user id. */
  guestNames = new Map<string, string>();
  /** The emailed sign-in code: sent, then used by the tab that asked. */
  signIn: 'none' | 'pending' | 'used' = 'none';
  /** Tries left on the emailed code (the API allows 5). */
  codeTries = 5;
  /** Sign-outs everywhere (#155), by user. */
  signedOutEverywhere: string[] = [];
  /** The lead's fingerprint of their link's bank details (#151). */
  payoutCheck: string | undefined;
  /** Sessions listed on /v1/me/sessions (the home tray and History). */
  mySessions: Record<string, unknown>[] = [];
  private seq = 0;
  pinnedBillVersion = 1;
  /** #64: how many the lead said are eating. */
  expectedDiners: number | undefined;
  /** #166: the lead's £1 hold, which the guests pay back by what they ordered. */
  platformFeePence: number | undefined;
  /** #65: the photo's printed total wasn't read (cut-off, usually). */
  private noPrintedTotal: boolean;
  /** #63: the venue the parser found, or the lead's own choice once amended. */
  private venue: { name: string; address?: string; placeId?: string } | undefined;
  /** #62: places GET /v1/venues/nearby returns (nearest first). */
  nearby: { placeId: string; name: string; address?: string; distanceM: number }[] = [];

  constructor(opts: { items?: Item[]; serviceRate?: number; status?: FakeApi['status']; leadClaims?: string[]; noPrintedTotal?: boolean; venue?: { name: string; address?: string } | null; platformFeePence?: number } = {}) {
    this.items = opts.items ?? items;
    this.platformFeePence = opts.platformFeePence;
    const subtotal = this.items.reduce((a, i) => a + i.unitPricePence * i.quantity, 0);
    this.serviceChargePence = Math.round(subtotal * (opts.serviceRate ?? 0));
    this.status = opts.status ?? 'claiming';
    this.noPrintedTotal = opts.noPrintedTotal ?? false;
    this.venue = opts.venue === null ? undefined : (opts.venue ?? { name: 'Gennaro', address: '12 King Street, Manchester' });
    this.participants = [
      { userId: 'u-lead', displayName: 'Callum Davies', claimedItemIds: opts.leadClaims ?? [this.items[0]!.itemId], sharedItemIds: [], payment: { status: 'self_paid' }, readyToLock: true },
    ];
  }

  get bill() {
    const subtotalPence = this.items.reduce((a, i) => a + i.unitPricePence * i.quantity, 0);
    return {
      billId: BID, versionNumber: this.pinnedBillVersion, creatorUserId: 'u-lead', currency: 'GBP', subtotalPence, taxPence: 0, serviceChargePence: this.serviceChargePence, totalPence: subtotalPence + this.serviceChargePence, items: this.items,
      // Matches the computed total by default, like a normal read; #65's
      // noPrintedTotal scenario is the cut-off-photo case.
      ...(this.noPrintedTotal ? {} : { parsedTotalPence: subtotalPence + this.serviceChargePence }),
      parsedFrom: { imageHash: 'a'.repeat(64), parser: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0', parserVersion: 'v3', parsedAt: '2026-10-31T12:00:00.000Z' },
      ...(this.venue ? { venue: this.venue } : {}),
      createdAt: '2026-10-31T12:00:00.000Z',
    };
  }

  session() {
    return {
      sessionId: SID, status: this.status, creatorUserId: 'u-lead', collectorUserId: 'u-lead', billId: BID, pinnedBillVersion: this.pinnedBillVersion, joinCode: CODE,
      venue: this.bill.venue, shares: this.shares, participants: this.participants, createdAt: '2026-10-31T12:00:00.000Z',
      ...(this.expectedDiners !== undefined ? { expectedDiners: this.expectedDiners } : {}),
      ...(this.platformFeePence ? { platformFeePence: this.platformFeePence } : {}),
      ...(this.payoutCheck ? { payoutCheck: this.payoutCheck } : {}),
    };
  }

  /** What each participant owes, the way the app projects it. */
  owed(userId: string): number {
    const p = this.participants.find((x) => x.userId === userId)!;
    const unit = (id: string) => this.items.find((i) => i.itemId === id)?.unitPricePence ?? 0;
    let sub = p.claimedItemIds.reduce((a, id) => a + unit(id), 0);
    for (const sh of this.shares) if (sh.userIds.includes(userId)) sub += Math.ceil((unit(sh.itemId) * (sh.units ?? 1)) / sh.ways);
    const b = this.bill;
    // #166: a guest's part of the hold, by what they ordered.
    const fee = userId !== 'u-lead' && this.platformFeePence && sub > 0 ? Math.floor((this.platformFeePence * sub) / b.subtotalPence) : 0;
    return Math.round(sub * (1 + (b.subtotalPence ? b.serviceChargePence / b.subtotalPence : 0))) + fee;
  }

  /**
   * A guest's payments. Tests that set the old single `payment` directly
   * read like sessions from before #121: that one payment, for what they owe.
   */
  entries(p: Participant): Entry[] {
    if (p.payments && p.payments.length > 0) return p.payments;
    const pay = p.payment;
    if (pay.status === 'pending' || pay.status === 'succeeded') {
      p.payments = [{
        paymentId: pay.paymentId, amountPence: this.owed(p.userId), status: pay.status,
        ...(pay.status === 'pending' && pay.payerClaimedPaidAt ? { payerClaimedPaidAt: pay.payerClaimedPaidAt } : {}),
        ...(pay.status === 'succeeded' ? { paidAt: pay.paidAt } : {}),
      }];
      return p.payments;
    }
    return [];
  }

  /** What a guest has sent: confirmed, or said they've sent (#121). */
  sent(userId: string): number {
    const p = this.participants.find((x) => x.userId === userId);
    return (p ? this.entries(p) : []).reduce((a, e) => (e.status === 'succeeded' || (e.status === 'pending' && e.payerClaimedPaidAt) ? a + e.amountPence : a), 0);
  }

  /** Like the API: a change that would drop a guest below what they've sent is refused. */
  private belowSent(userId: string, change: () => void, undo: () => void): boolean {
    const sent = this.sent(userId);
    change();
    if (userId !== 'u-lead' && sent > 0 && this.owed(userId) < sent) { undo(); return true; }
    return false;
  }

  private me(userId: string) {
    return this.participants.find((p) => p.userId === userId)!;
  }

  join(u: User) {
    if (!this.participants.some((p) => p.userId === u.userId)) {
      this.participants.push({ userId: u.userId, displayName: u.displayName, claimedItemIds: [], sharedItemIds: [], payment: { status: 'unpaid' }, readyToLock: false });
    }
  }

  private takeFault<K extends Fault['kind']>(kind: K): Extract<Fault, { kind: K }> | undefined {
    const i = this.faults.findIndex((f) => f.kind === kind);
    if (i < 0) return undefined;
    const f = this.faults[i] as Extract<Fault, { kind: K }>;
    if ('times' in f) { f.times -= 1; if (f.times <= 0) this.faults.splice(i, 1); } else this.faults.splice(i, 1);
    return f;
  }

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
    await ctx.route('**/v1/**', (route) => this.handle(route, user));
  }

  private handle(route: Route, user: User) {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const raw = req.postData();
    this.requests.push({ method, path, body: raw });
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const err = (code: string, message: string, status: number, details?: Record<string, unknown>) => json({ error: { code, message, ...(details ? { details } : {}) } }, status);
    const body = () => (raw ? (JSON.parse(raw) as Record<string, unknown>) : {});

    // ---- auth
    if (path === '/v1/auth/email/dev-sign-in') return err('NOT_FOUND', 'no', 404);
    if (path === '/v1/auth/email/start') { this.signIn = 'pending'; this.codeTries = 5; return json({ ok: true, requestId: SIGN_IN_REQUEST }); }
    if (path === '/v1/auth/email/verify') {
      const { requestId, code } = body() as { requestId?: string; code?: string };
      if (requestId !== SIGN_IN_REQUEST || this.codeTries <= 0) return json({ status: 'expired' });
      this.codeTries -= 1;
      if (code === SIGN_IN_CODE && this.signIn !== 'none') {
        this.signIn = 'used'; this.signedIn.add(user.userId); this.join(user);
        return json({ status: 'signedIn', token: 'test-token', user });
      }
      if (this.signIn !== 'pending' || this.codeTries <= 0) return json({ status: 'expired' });
      return json({ status: 'wrong', attemptsLeft: this.codeTries });
    }
    if (path === '/v1/me') {
      const auth = req.headers()['authorization'];
      if (!auth) return err('AUTH_MISSING', 'No token', 401);
      const guest = this.guestNames.get(user.userId);
      return json(auth === 'Bearer guest-token' && guest ? { userId: user.userId, displayName: guest, guestSessionId: SID } : user);
    }
    // #183: the QR's landing page and joining with just a name.
    if (path === '/v1/sessions/preview') {
      if ((body().code as string) !== CODE) return err('NOT_FOUND', 'Code not found', 404);
      const host = this.participants.find((p) => p.userId === 'u-lead');
      return json({
        sessionId: SID, status: this.status, hostName: (host?.displayName ?? 'Callum').split(' ')[0],
        ...(this.venue ? { venueName: this.venue.name } : {}), createdAt: '2026-10-31T12:00:00Z',
        itemCount: this.items.reduce((n, i) => n + i.quantity, 0), totalPence: this.bill.totalPence,
        people: this.participants.map((p) => p.displayName.split(' ')[0]),
      });
    }
    if (path === '/v1/sessions/guest-join') {
      const { code, name } = body() as { code?: string; name?: string };
      if (code !== CODE || this.status !== 'claiming') return err('NOT_FOUND', 'Code not active', 404);
      const n = (name ?? '').trim();
      if (!n) return err('INVALID_INPUT', 'name', 400);
      this.guestNames.set(user.userId, n);
      this.join({ ...user, displayName: n });
      return json({ token: 'guest-token', session: this.session() }, 201);
    }
    if (path === '/v1/me/sign-out' && method === 'POST') { this.signedOutEverywhere.push(user.userId); return json({ ok: true }); }
    if (path.startsWith('/v1/me/sessions')) return json({ sessions: this.mySessions });
    if (path === '/v1/me/payout-account') return method === 'GET' ? err('NOT_FOUND', 'none', 404) : json({ ok: true });

    // ---- bills
    if (path === '/v1/bills/uploads') return json({ status: 'new', uploadId: 'up-1', url: 'http://localhost:9000/v1/_s3/up-1', expiresAt: '2099-01-01T00:00:00Z', maxBytes: 10_000_000 });
    if (path === '/v1/_s3/up-1') return route.fulfill({ status: 200, body: '' });
    if (path === '/v1/bills/reads' && method === 'POST') {
      const f = this.takeFault('parse');
      const readId = `00000000-0000-4000-8000-${String(700 + ++this.seq).padStart(12, '0')}`;
      this.reads.set(readId, { polls: 0, ...(f ? { error: { code: f.code, message: f.message, ...(f.details ? { details: f.details } : {}) } } : {}) });
      return json({ readId, status: 'reading' }, 202);
    }
    if (path.startsWith('/v1/bills/reads/') && method === 'GET') {
      const readId = path.slice('/v1/bills/reads/'.length);
      const r = this.reads.get(readId);
      if (!r) return err('NOT_FOUND', 'Read not found', 404);
      r.polls += 1;
      if (this.holdReads || r.polls <= this.readPolls) return json({ readId, status: 'reading' });
      if (r.error) return json({ readId, status: 'failed', error: r.error });
      return json({ readId, status: 'done', billId: BID });
    }
    if (path === '/v1/bills/parse') {
      const f = this.takeFault('parse');
      if (f) return err(f.code, f.message, f.code === 'IMAGE_TOO_LARGE' ? 413 : f.code === 'PARSE_TIMEOUT' ? 504 : 422, f.details);
      return json(this.bill);
    }
    if (path === `/v1/bills/${BID}` && method === 'GET') return json(this.bill);
    if (path === `/v1/bills/${BID}/amend`) {
      const b = body() as { items: { itemId?: string; name: string; unitPricePence: number; quantity: number; category: string }[]; serviceChargePence: number; venue?: { name: string; placeId?: string; address?: string } };
      this.items = b.items.map((it) => ({ itemId: it.itemId ?? `00000000-0000-4000-8000-${String(900 + ++this.seq).padStart(12, '0')}`, name: it.name, unitPricePence: it.unitPricePence, quantity: it.quantity, category: it.category }));
      this.serviceChargePence = b.serviceChargePence;
      if (b.venue) this.venue = b.venue;
      this.pinnedBillVersion += 1;
      return json(this.bill);
    }
    if (path === `/v1/bills/${BID}/image-url`) return err('IMAGE_UNAVAILABLE', 'n/a', 404);

    // ---- sessions
    if (path === '/v1/venues/nearby' && method === 'GET') return json({ venues: this.nearby });
    if (path === '/v1/sessions' && method === 'POST') {
      this.status = 'setup';
      const n = body().expectedDiners as number | undefined;
      this.expectedDiners = n;
      return json(this.session(), 201);
    }
    if (path === '/v1/sessions/by-code') return (body().code as string) === CODE ? json({ sessionId: SID }) : err('NOT_FOUND', 'No session with that code', 404);
    if (path === `/v1/sessions/${SID}/share`) { this.status = 'claiming'; return json(this.session()); }
    if (path === `/v1/sessions/${SID}/join`) {
      // Like the API: someone already at the table gets back in whatever the
      // state; newcomers only while the bill is open.
      if (!this.participants.some((p) => p.userId === user.userId) && this.status !== 'claiming') {
        return err('SESSION_INVALID_STATE', this.status === 'settled' ? 'This bill has been closed' : 'Session is not accepting joins', 409, { status: this.status });
      }
      this.join(user);
      return json(this.session());
    }
    if (path === `/v1/sessions/${SID}` && method === 'GET') {
      if (this.takeFault('session-get-500')) return err('INTERNAL_ERROR', 'boom', 500);
      return json(this.session());
    }
    if (path === `/v1/sessions/${SID}/payout-check` && method === 'PUT') {
      if (user.userId !== 'u-lead') return err('SESSION_NOT_FOUND', 'Session not found', 404);
      this.payoutCheck = body().payoutCheck as string;
      return json(this.session());
    }
    if (path === `/v1/sessions/${SID}` && method === 'PATCH') {
      if (user.userId !== 'u-lead') return err('SESSION_NOT_FOUND', 'Session not found', 404);
      const n = body().expectedDiners as number | null;
      if (n !== null && (!Number.isInteger(n) || n < 2 || n > 10)) return err('INVALID_INPUT', 'Validation failed', 400);
      this.expectedDiners = n ?? undefined;
      return json(this.session());
    }
    if (path === `/v1/sessions/${SID}/abandon`) { this.status = 'abandoned'; return json(this.session()); }
    if (path === `/v1/sessions/${SID}/report` && method === 'POST') {
      if (this.status === 'setup' || this.status === 'abandoned') return err('SESSION_INVALID_STATE', `Session is ${this.status}`, 409);
      this.reportsTo.push(user.userId);
      return json({ sent: true }, 202);
    }
    if (path === `/v1/sessions/${SID}/close` && method === 'POST') {
      if (user.userId !== 'u-lead') return err('SESSION_NOT_FOUND', 'Session not found', 404);
      if (this.status === 'setup' || this.status === 'abandoned') return err('SESSION_INVALID_STATE', `Session is ${this.status}`, 409);
      this.status = 'settled';
      return json(this.session());
    }

    const me = this.me(user.userId);
    if (!me) return err('SESSION_NOT_FOUND', 'Session not found', 404);
    const paidFor = () => err('ALREADY_PAID_FOR', 'You’ve already paid for that', 409);

    if (path === `/v1/sessions/${SID}/claims` && method === 'POST') {
      if (this.status !== 'claiming') return err('SESSION_INVALID_STATE', 'Claims cannot be modified in this state', 409);
      const next = body().claimedItemIds as string[];
      for (const it of this.items) {
        const mine = next.filter((id) => id === it.itemId).length;
        const sh = this.shares.find((x) => x.itemId === it.itemId && x.userIds.length > 0);
        const split = sh ? (sh.units ?? 1) : 0;
        const others = split + this.participants.filter((p) => p.userId !== user.userId).reduce((a, p) => a + p.claimedItemIds.filter((id) => id === it.itemId).length, 0);
        if (mine + others > it.quantity) return err('SESSION_INVALID_STATE', `Only ${it.quantity - others} of "${it.name}" left to claim`, 409, { itemId: it.itemId });
      }
      const before = me.claimedItemIds;
      if (this.belowSent(user.userId, () => { me.claimedItemIds = next; }, () => { me.claimedItemIds = before; })) return paidFor();
      return json(this.session());
    }
    if (path === `/v1/sessions/${SID}/shares` && method === 'POST') {
      const { itemId, ways, units } = body() as { itemId: string; ways?: number; units?: number };
      const line = this.items.find((i) => i.itemId === itemId)!;
      const existing = this.shares.find((s) => s.itemId === itemId);
      if (existing) {
        const full = existing.userIds.length >= existing.ways;
        if (!existing.userIds.includes(user.userId) && full && existing.userIds.some((u) => this.sent(u) > 0)) {
          return err('SHARE_PAID', 'Someone in this split has paid, so it can’t be split more ways', 409, { itemId });
        }
        if (!existing.userIds.includes(user.userId)) {
          existing.userIds.push(user.userId);
          existing.ways = Math.max(existing.ways, existing.userIds.length);
        }
      } else if (line.quantity > 1) {
        // Some of a longer line: taken from what nobody has claimed.
        const left = line.quantity - this.participants.reduce((a, p) => a + p.claimedItemIds.filter((id) => id === itemId).length, 0);
        const n = units ?? left;
        if (n < 1 || n > left) return err('SESSION_INVALID_STATE', `Only ${left} of "${line.name}" left to split`, 409, { itemId });
        this.shares.push({ itemId, userIds: [user.userId], ways: Math.max(ways ?? 2, 2), units: n, activity: [] });
      } else {
        // #130: splitting something someone else claimed makes their claim
        // their spot in the split, unless they've paid.
        const claimer = this.participants.find((p) => p.userId !== user.userId && p.claimedItemIds.includes(itemId));
        if (me.claimedItemIds.includes(itemId)) return err('CLAIM_SHARE_CONFLICT', 'You’ve claimed it; remove it before splitting it', 409, { itemId });
        if (claimer && (claimer.payment.status === 'pending' || claimer.payment.status === 'succeeded')) {
          return err('SHARE_PAID', 'They’ve already paid for it, so it can’t be split', 409, { itemId });
        }
        if (claimer) {
          claimer.claimedItemIds = claimer.claimedItemIds.filter((id) => id !== itemId);
          claimer.sharedItemIds.push(itemId);
        }
        this.shares.push({ itemId, userIds: claimer ? [claimer.userId, user.userId] : [user.userId], ways: Math.max(ways ?? 2, 2), units: 1, activity: [] });
      }
      if (line.quantity === 1) me.claimedItemIds = me.claimedItemIds.filter((id) => id !== itemId);
      if (!me.sharedItemIds.includes(itemId)) me.sharedItemIds.push(itemId);
      return json(this.session());
    }
    const shareMatch = path.match(new RegExp(`^/v1/sessions/${SID}/shares/([^/]+)$`));
    if (shareMatch && method === 'DELETE') {
      const itemId = shareMatch[1]!;
      const sh = this.shares.find((s) => s.itemId === itemId);
      const beforeIds = sh ? [...sh.userIds] : [];
      const beforeShared = [...me.sharedItemIds];
      const leave = () => { if (sh) sh.userIds = sh.userIds.filter((id) => id !== user.userId); me.sharedItemIds = me.sharedItemIds.filter((id) => id !== itemId); };
      const undo = () => { if (sh) sh.userIds = beforeIds; me.sharedItemIds = beforeShared; };
      if (this.belowSent(user.userId, leave, undo)) return paidFor();
      return json(this.session());
    }
    if (shareMatch && method === 'PUT') {
      const sh = this.shares.find((s) => s.itemId === shareMatch[1]);
      const ways = body().ways as number;
      if (sh && ways < sh.userIds.length) return err('SHARE_WAYS_TOO_LOW', 'More people are in it already', 409);
      if (sh) sh.ways = ways;
      return json(this.session());
    }

    // ---- payments
    if (path === `/v1/sessions/${SID}/payments` && method === 'POST') {
      if (this.takeFault('initiate-500')) return err('INTERNAL_ERROR', 'boom', 500);
      // #121: pay what's owed now less what's been sent; reuse an unsent
      // payment for the same amount, else replace it.
      const entries = this.entries(me);
      const sent = this.sent(user.userId);
      const amountPence = this.owed(user.userId) - sent;
      if (amountPence <= 0) return err('SESSION_INVALID_STATE', sent > 0 ? 'Nothing more to pay' : 'Nothing claimed yet', 409);
      const draft = [...entries].reverse().find((e) => e.status === 'pending' && !e.payerClaimedPaidAt);
      let entry = draft && draft.amountPence === amountPence ? draft : undefined;
      if (!entry) {
        if (draft) draft.status = 'failed';
        entry = { paymentId: `00000000-0000-4000-9000-${String(++this.seq).padStart(12, '0')}`, amountPence, status: 'pending' };
        me.payments = [...entries.filter((e) => e !== draft), entry];
      }
      me.payment = aggregate(me.payments ?? []);
      return json({
        payment: { paymentId: entry.paymentId, sessionId: SID, payerUserId: user.userId, amountPence, status: 'pending' },
        instructions: { type: 'manual_transfer', reference: 'gdp-0193ab12', amountPence, links: {}, bankDetails: LEAD_BANK },
      }, 201);
    }
    const payMatch = path.match(/^\/v1\/payments\/([^/]+)\/(mark-paid|confirm)$/);
    if (payMatch) {
      const [, paymentId, action] = payMatch;
      const payer = this.participants.find((p) => this.entries(p).some((e) => e.paymentId === paymentId));
      const entry = payer?.payments?.find((e) => e.paymentId === paymentId);
      if (!payer || !entry) return err('PAYMENT_NOT_FOUND', 'no', 404);
      if (action === 'mark-paid' && entry.status === 'pending') entry.payerClaimedPaidAt ??= new Date().toISOString();
      if (action === 'confirm') { entry.status = 'succeeded'; entry.paidAt = new Date().toISOString(); }
      payer.payment = aggregate(payer.payments!);
      // Deliberately no auto-settle: only the lead's close ends the bill.
      return json({ paymentId, sessionId: SID, payerUserId: payer.userId, amountPence: entry.amountPence, status: entry.status });
    }
    return err('NOT_FOUND', `unhandled ${method} ${path}`, 404);
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
