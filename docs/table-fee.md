# Platform fee

The model is in [decisions](decisions.md) (*Pricing*, #171). Each lead gets **one free bill a month** (a *credit*). Without one, sharing puts a **£1 hold** on the lead's card before the QR (#165), in Stripe's embedded form (`ui_mode: "form"`): Apple Pay, Google Pay or card. Nothing is taken then. Card details never leave Stripe's iframe. Everything before the QR (scan, check, edit, bank details) stays free.

**Guests pay it back** (#166): sharing on a hold writes `platformFeePence` on the session, and each guest's bill adds *Platform fee* `floor(hold × their items ÷ the bill's items)` (`feeSharePence` in `ledger.ts` and core `owed.ts`, pinned by `owed.property.test.ts`). It's fixed by the bill, so it doesn't depend on who joins or pays first, and the guests' parts never add up to more than the hold. The lead pays none; it's in the guests' totals, payments, the lead's statement and the emailed report.

**At close** (#167): with guests at the table, `POST /v1/sessions/{id}/close` takes the guests' parts, in total and at most the hold, from the hold that shared this session (`paymentIntents.capture` with `amount_to_capture`, idempotency key `table-fee-capture-<checkout session>`; `sessionService.guestsFeePence` adds them up from the stored session and the pinned bill) and writes `capturedPence` / `capturedAt` on the `FEE#` row, once. Stripe releases the rest. Under Stripe's 30p minimum the hold is cancelled instead. Binning a bill (`/abandon`) releases the hold: nothing is taken. A capture Stripe already made (a lost row write) is recorded rather than repeated; a hold that lapsed is recorded as released. The close dialog says "£0.50 of your £1 hold is taken; your guests pay it back." (or "Your £1 hold is released."), the closed bill shows *Taken from your hold*, and the account counts what was taken as paid. Tests: *take from the hold at close* in `tableFee.test.ts`, and *the £1 hold at close* in `tests/integration/table-fee-refund.test.ts`.

**Before it lapses** (#168): a card hold lasts about 7 days. Sharing on a hold also writes `HOLDQ#<billId>` (GSI1 `HOLDS`, sorted by `heldAt`) in the share transaction. Every day at 03:17 UTC an EventBridge rule invokes the API Lambda with `{ "gdpHoldSweep": true }` (`src/ops/holdSweep.ts`). For each hold not yet settled: on a bill still open, one older than 6 days has the guests' part taken now (the bill stays open; closing it later takes nothing more, and anyone who claims after that pays their part to the lead, who keeps it); on a bill closed or binned whose hold Stripe failed to settle, it tries again; nobody joined releases it. Settled ones are cleared from the index. A hold it couldn't settle stays for the next day and the run throws, so the Lambda errors alarm fires. Tests: `holdSweep.test.ts`, and the index row in `tests/integration/table-fee-share.test.ts`.

**Credit packs** (#169): 10 credits for £5. They never expire and can't be refunded (the Terms and Refunds pages say why). `/credits` (from the account page, or "Or buy 10 credits for £5" on the hold page) mounts the same embedded form (`components/StripeForm.tsx`) for `POST /v1/billing/credit-packs` (`price_data` £5, metadata `kind: "credits"`). The webhook adds them once per Checkout Session; `GET /v1/billing/credit-packs/{cs}` asks Stripe if the webhook is late. Storage: `CREDITS#<userId>` with a `BALANCE` row and one row per pack (`BUY#<cs>`), spend (`SPEND#<sessionId>`) and give-back (`RETURN#<sessionId>`), no TTL. Sharing spends the month's free credit first, then a bought one (status `credit`: the share transaction takes 1 off the balance, conditional on it being at least 1, and writes `SPEND#`), then asks for the hold. A credit makes the bill free for everyone: no hold, no fee line. A bought credit spent on a bill nobody joined is given back. The account shows credits left (free plus bought) and counts packs in what's been paid. Tests: *credit packs* in `tableFee.test.ts` and *bought credits* in `tests/integration/table-fee-share.test.ts` (including two shares racing for the last credit).

The billing routes only exist when `STRIPE_SECRET_KEY` is set. Without it there's no fee and no credits: *Continue* on the bill goes straight to the QR, and the server shares without asking.

## The server enforces it (#139)

`POST /v1/sessions/{id}/share` (the QR) needs one of these, checked in this order, or it answers `402 TABLE_FEE_REQUIRED`:

1. **The bill's hold** (or, from before holds, its paid fee): not released or refunded, and not already spent on another session. *One fee, one share*: the share writes its `sessionId` onto the `FEE#<billId>` row in the same transaction that moves the session to `claiming`, conditional on the row still being unrefunded and unspent. So a lead can't pay once, close a bill people joined, edit it into another meal and share it again on the same fee.
2. **An exempt lead** (`waived`), below.
3. **This month's credit**: a `CREDIT#<userId>#<yyyy-mm>` row (month in UK time), put in the same share transaction if it doesn't exist yet (or was handed back). Two shares racing for one credit: one gets it, the other gets 402.

The web app sends the Checkout Session it just paid with the share (`{ checkoutSessionId }`), so a late webhook doesn't block it: the server checks that session with Stripe, as the status route does. On a 402 the web app sends the lead to the fee page, which shares the waiting table once paid. A fee replaced by a new payment (after a refund, or once spent) is copied to `FEE#<billId>` / `FEE#<checkoutSessionId>` first, so every payment stays on record.

`GET /v1/billing/table-fee/<billId>` returns `free` (with `creditsLeft: 1` and `nextCreditOn`, the 1st of next month) when the credit is there, else `unpaid` with `creditsLeft: 0`. `GET /v1/billing/me` lists the lead's fees and credits (GSI1 `FEES#<userId>`) for the account page and the closed bill. Tests: `tests/integration/table-fee-share.test.ts`, and *monthly credit* in `tableFee.test.ts`.

**Screens** (#128): with a credit, the bill's button is *Spend 1 credit & get QR code* over "1 credit left · you get 1 free each month", and the QR page says "1 credit spent · next credit 1 Dec". Without one, *Hold £1 & get QR code* over "Nothing taken now · your guests pay it back" leads to the fee page: "No credits left this month. Next one 1 Dec." with *Platform fee hold £1.00* as one row, then the form and "Nothing taken now · Your guests pay it back · Released if nobody joins". The QR page says "£1 hold · nothing taken now". The account shows *Credits* (n left) and *Fees paid* (with what was refunded). Then the QR fills in over about a second (#129); Copy link, Share and *Go to the bill* wait for it. Reduced motion shows it at once.

## How it works

1. On the bill page, *Hold £1 & get QR code* re-checks with the API and goes to `/table-fee/<billId>` if there's no hold or credit.
2. `POST /v1/billing/table-fee` checks the bill is the caller's and has no hold, and creates a Checkout Session for £1 (`price_data` in code, product *Platform fee*: no Dashboard prices) with `payment_intent_data.capture_method: "manual"`, `client_reference_id` and `metadata` `{ billId, userId, kind: "hold" }`.
3. The page mounts the form. Cards and wallets finish in place; anything that needs a redirect comes back to the same page with `?session_id=`.
4. Stripe calls `POST /webhooks/stripe`. After the signature check, `checkout.session.completed` for a hold (it completes `unpaid`) is checked against its PaymentIntent: `requires_capture` writes `FEE#<billId>` with `kind: "hold"` and the authorised amount (once; repeats write nothing; a released or refunded one can be replaced by a new hold). The row has no TTL: it's a tax record.
5. The page polls `GET /v1/billing/table-fee/<billId>?session_id=<cs_…>` until it's `held`, then continues to the QR. If the webhook hasn't landed, the API asks Stripe about that Checkout Session and records the hold itself when it's the caller's, for this bill, and authorised. So a late or missing webhook (locally, no `stripe listen`) no longer leaves the page spinning. After 30 seconds unpaid the page stops polling and offers *Check again*.

**Nobody joined** (#132, #165). After `POST /v1/sessions/{id}/close` or `/abandon`, if nobody but the lead is in the session and the hold paid for this session, the API cancels the hold in Stripe (idempotency key `table-fee-release-<checkout session>`; one Stripe already cancelled, or that lapsed, counts as released) and writes `releasedAt` on the `FEE#` row (once). Nothing was taken. A fee paid outright before holds is refunded instead (`table-fee-refund-<checkout session>`, `refundId` and `refundedAt`). Closing or binning never fails because of Stripe: an error is logged as `table_fee.refund_failed` and the next close or bin tries again. A released hold counts as no hold, so sharing that bill again needs a new one. A credit spent on a session nobody joined is handed back the same way (`returnedAt` on the `CREDIT#` row, this month's only). The close and delete dialogs say so ("Nobody joined, so your £1 hold is released."), and the closed bill shows a *Platform fee* section: *Hold released*, *Hold on your card*, or *Credit given back*. Tests: `tableFee.test.ts` (*hold release*, *refund policy*) and `tests/integration/table-fee-refund.test.ts`, with Stripe faked; after each dev deploy the dependency check places and releases a £1 hold in the Stripe sandbox through the same code, and places another and takes 66p from it as at close (*Stripe hold (nobody joined)*).

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

- [ ] Archive the old *Table fee* product and its £2/£3 prices (`table_fee_2`, `table_fee_3`) in the sandbox: the code no longer uses them (#170).
- [ ] Live keys, live webhook endpoint, live domain registration (`paymeback.dev`; the sandbox has `paymeback.dev` and `test.paymeback.dev`).
- [ ] At activation, Business details: public business name *Pay Me Back*, statement descriptor `PAYMEBACK.DEV` (what banks show). The sandbox can't set these until the account is activated.
- [x] One free bill a month per lead (#139).
- [x] The server requires the fee or the month's credit at `POST /v1/sessions/{id}/share` (#139).
- [x] Guests repay the £1 in proportion to what they ordered (#166).
- [x] It's taken from the hold at close (#167).
- [x] Holds on bills left open are taken before they lapse (#168).
- [x] Release the hold (or refund an old fee) when a bill is closed or abandoned before anyone joins, shown on the close screen and the account (#132, #165).
- [ ] e2e: stub the form in `FakeApi` and cover pay → share.
