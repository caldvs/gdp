# Platform fee

Each lead gets **one free bill a month** (a *credit*). After that they pay £2 (£3 when the bill is over £100) before getting the QR code, in Stripe's embedded form (`ui_mode: "form"`): Apple Pay, Google Pay or card. Card details never leave Stripe's iframe. Everything before the QR (scan, check, edit, bank details) stays free.

The billing routes only exist when `STRIPE_SECRET_KEY` is set. Without it there's no fee and no credits: *Continue* on the bill goes straight to the QR, and the server shares without asking.

## The server enforces it (#139)

`POST /v1/sessions/{id}/share` (the QR) needs one of these, checked in this order, or it answers `402 TABLE_FEE_REQUIRED`:

1. **The bill's paid fee**: not refunded, and not already spent on another session. *One fee, one share*: the share writes its `sessionId` onto the `FEE#<billId>` row in the same transaction that moves the session to `claiming`, conditional on the row still being unrefunded and unspent. So a lead can't pay once, close a bill people joined, edit it into another meal and share it again on the same fee.
2. **An exempt lead** (`waived`), below.
3. **This month's credit**: a `CREDIT#<userId>#<yyyy-mm>` row (month in UK time), put in the same share transaction if it doesn't exist yet (or was handed back). Two shares racing for one credit: one gets it, the other gets 402.

The web app sends the Checkout Session it just paid with the share (`{ checkoutSessionId }`), so a late webhook doesn't block it: the server checks that session with Stripe, as the status route does. On a 402 the web app sends the lead to the fee page, which shares the waiting table once paid. A fee replaced by a new payment (after a refund, or once spent) is copied to `FEE#<billId>` / `FEE#<checkoutSessionId>` first, so every payment stays on record.

`GET /v1/billing/table-fee/<billId>` returns `free` (with `creditsLeft: 1` and `nextCreditOn`, the 1st of next month) when the credit is there, else `unpaid` with `creditsLeft: 0`. `GET /v1/billing/me` lists the lead's fees and credits (GSI1 `FEES#<userId>`) for the account page and the closed bill. Tests: `tests/integration/table-fee-share.test.ts`, and *monthly credit* in `tableFee.test.ts`.

**Screens** (#128): with a credit, the bill's button is *Spend 1 credit & get QR code* over "1 credit left · you get 1 free each month", and the QR page says "1 credit spent · next credit 1 Dec". Without one, *Pay £x platform fee & get QR code* leads to the fee page: "No credits left this month. Next one 1 Dec." with the fee as one row, then the form and "Refunded if nobody joins · Apple Pay, Google Pay or card". The account shows *Credits* (n left) and *Fees paid* (with what was refunded). Then the QR fills in over about a second (#129); Copy link, Share and *Go to the bill* wait for it. Reduced motion shows it at once.

## How it works

1. On the bill page, *Pay £x platform fee & get QR code* re-checks the fee with the API (an edit may have crossed £100) and goes to `/table-fee/<billId>` if it's unpaid.
2. `POST /v1/billing/table-fee` checks the bill is the caller's and unpaid, picks the price by lookup key (`table_fee_2` or `table_fee_3`), and creates a Checkout Session with `client_reference_id` and `metadata.billId`.
3. The page mounts the form. Cards and wallets finish in place; anything that needs a redirect comes back to the same page with `?session_id=`.
4. Stripe calls `POST /webhooks/stripe`. After the signature check, `checkout.session.completed` with `payment_status: paid` writes `FEE#<billId>` (once; repeats write nothing; a refunded fee can be replaced by a new payment). The row has no TTL: it's a tax record.
5. The page polls `GET /v1/billing/table-fee/<billId>?session_id=<cs_…>` until it's `paid`, then continues to the QR. If the webhook hasn't landed, the API asks Stripe about that Checkout Session and records the fee itself when it's the caller's, for this bill, and paid. So a late or missing webhook (locally, no `stripe listen`) no longer leaves the page spinning. After 30 seconds unpaid the page stops polling and offers *Check again*.

**Refunds** (the Refunds page: "If nobody joins the bill before you close it or bin it, we refund the fee to your card"). **The rule for now: refund at close or bin only, no time limit** (decided 4 Nov 2026 as the safe default for #132; Callum can revisit, e.g. also refunding after 24 hours with nobody joined). After `POST /v1/sessions/{id}/close` or `/abandon`, if nobody but the lead is in the session and the bill has a paid fee that paid for this session (a fee spent on an earlier share of the same bill, which people joined, stays paid), the API refunds the whole payment in Stripe (idempotency key `table-fee-refund-<checkout session>`) and writes `refundId` and `refundedAt` on the `FEE#` row (once). Closing or binning never fails because of a refund: a Stripe error is logged as `table_fee.refund_failed` and the next close or bin tries again. A refunded fee counts as unpaid, so sharing that bill again costs a new fee; a resent webhook for the refunded payment writes nothing. A credit spent on a session nobody joined is handed back the same way (`returnedAt` on the `CREDIT#` row, this month's only), so it can be spent again. The close and delete dialogs say so ("Nobody joined, so your £2 fee is refunded."), and the closed bill shows a *Platform fee* section: *Refunded* or *Paid when you shared*, or *Credit given back*. The "email us" cases on the Refunds page stay manual. Tests: `tableFee.test.ts` (*refund policy*) and `tests/integration/table-fee-refund.test.ts`, with Stripe faked; after each dev deploy the dependency check pays and refunds £2 in the Stripe sandbox through the same code (*Stripe refund (nobody joined)*).

**Exempt leads.** An email on `TABLE_FEE_EXEMPT_EMAILS` gets status `waived` (£0): *Continue* goes straight to the QR, and `POST /v1/billing/table-fee` refuses with `TABLE_FEE_WAIVED`. The same addresses sign in without a code (`/v1/auth/email/start` returns the session). A fee paid before the address was added still shows as `paid`.

Code: `apps/api/src/services/billing/tableFee.ts`, `routes/billing.ts`, `routes/stripeWebhook.ts`, `storage/tableFeeStore.ts`, `packages/core/src/api/hooks/useTableFee.ts`, `apps/web/app/(app)/table-fee/[billId]/page.tsx`.

## Running it locally

1. `apps/api/.env.local`: `STRIPE_SECRET_KEY=sk_test_…`
2. `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to localhost:3000/webhooks/stripe`, and put the `whsec_…` it prints in `STRIPE_WEBHOOK_SECRET`.
3. `apps/web/.env.local`: `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…`
4. `npm run dev:local`.

Test cards: `4242 4242 4242 4242` succeeds, `4000 0025 0000 3155` needs 3D Secure, `4000 0000 0000 9995` is declined. Wallet buttons need HTTPS and a registered domain, so try them on the deployed site.

## Deploying

1. Secrets Manager (eu-west-2): `gdp-dev/stripe-secret-key` and `gdp-dev/stripe-webhook-secret`.
2. GitHub → Environments → `dev`: variables `STRIPE_ENABLED=true` and `APP_BASE_URL` (the web app's URL). Optional: `TABLE_FEE_EXEMPT_EMAILS`, a comma list of emails that never pay and sign in with no code (a secret keeps them out of logs; a variable works too). Takes effect on the next API deploy.
3. Stripe webhook endpoint `<API URL>/webhooks/stripe` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in the Vercel build environment.
5. Register the web domain under Payment method domains (sandbox and live), or the wallets won't show.
6. In Payment methods, turn off Link and Amazon Pay. Keep Cards on: the wallets run on it.

## Before it takes real money

- [ ] Live product *Platform fee* (the sandbox product is still named *Table fee*; rename it at live activation, #79) with two one-time GBP prices, lookup keys `table_fee_2` (£2.00) and `table_fee_3` (£3.00). The sandbox has them.
- [ ] Live keys, live webhook endpoint, live domain registration (`paymeback.dev`; the sandbox has `paymeback.dev` and `test.paymeback.dev`).
- [ ] At activation, Business details: public business name *Pay Me Back*, statement descriptor `PAYMEBACK.DEV` (what banks show). The sandbox can't set these until the account is activated.
- [x] One free bill a month per lead (#139).
- [x] The server requires the fee or the month's credit at `POST /v1/sessions/{id}/share` (#139).
- [ ] Guests repay their share of the fee in what they owe, shown as "App fee".
- [x] Refund automatically when a bill is closed or abandoned before anyone joins, shown on the close screen and the account (#132).
- [ ] e2e: stub the form in `FakeApi` and cover pay → share.
