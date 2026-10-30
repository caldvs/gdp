# Stripe integration: what's left

The lead's table fee (£2, or £3 when the bill is over £100) is paid in Stripe's embedded form (`ui_mode: "form"`). This file is the single list of what still has to happen before it takes real money.

## Values to Replace

No placeholder values are left in code. `mode` is `"payment"` (a one-time fee) and the price is looked up at runtime by lookup key, so there's no `price_...` to paste in.

**Files containing these values:**
- [apps/api/src/services/billing/tableFee.ts](apps/api/src/services/billing/tableFee.ts)

| Field | Current Value | What to Set |
|-------|--------------|-------------|
| mode | `payment` | Nothing: the fee is a one-time charge. |
| line_items[].price | Looked up by key: `table_fee_2` (bill up to £100) or `table_fee_3` (over £100) | Nothing in code. In **live mode**, create the *Table fee* product with two one-time GBP prices, £2.00 with lookup key `table_fee_2` and £3.00 with `table_fee_3` (the sandbox already has them). |

## Configured Parameters

These parameters were configured in Checkout Studio and are already set correctly.

**Files containing these parameters:**
- [apps/api/src/services/billing/tableFee.ts](apps/api/src/services/billing/tableFee.ts) (server, `checkoutSessionParams`)
- [apps/web/app/(app)/table-fee/[billId]/page.tsx](apps/web/app/(app)/table-fee/[billId]/page.tsx) (client appearance)

| Parameter | Value |
|-----------|-------|
| ui_mode | `form` |
| billing_address_collection | `auto` |
| phone_number_collection | `{ enabled: false }` |
| automatic_tax | `{ enabled: false }` |
| submit_type | `auto` |
| name_collection | `{ individual: { enabled: true, optional: true } }` |
| integration_identifier | `custom_embedded_web_0001` |
| payment_method_collection | Not sent: it only applies to subscriptions |
| appearance (client) | `theme: stripe`, `labels: auto`, `inputs: spaced`, primary `#0570de`, radius `4px`, base font `16px` |

## Setup

### Local

1. API: in `apps/api/.env.local` set `STRIPE_SECRET_KEY=sk_test_...` from [API keys](https://dashboard.stripe.com/test/apikeys). Without it, the billing routes aren't mounted.
2. Webhook: `stripe listen --events checkout.session.completed,checkout.session.async_payment_succeeded --forward-to localhost:3000/webhooks/stripe` (newer CLIs need `--events`), then put the `whsec_...` it prints in `STRIPE_WEBHOOK_SECRET`.
3. `APP_BASE_URL` defaults to `http://localhost:8081`; change it if the web app runs elsewhere.
4. Web: in `apps/web/.env.local` set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...`. Never put the secret key in a `NEXT_PUBLIC_` variable.
5. `npm run dev:local`, then open `/table-fee/<billId>` for a bill you created.

### Deployed (dev, then prod)

1. Create the secrets: `gdp-dev/stripe-secret-key` and `gdp-dev/stripe-webhook-secret` in Secrets Manager.
2. Add them to the Lambda environment in [apps/api/infra/main.ts](apps/api/infra/main.ts), next to the TrueLayer ones:

   ```ts
   const stripeSecretKey = cdk.SecretValue.secretsManager(`gdp-${envName}/stripe-secret-key`);
   const stripeWebhookSecret = cdk.SecretValue.secretsManager(`gdp-${envName}/stripe-webhook-secret`);
   // in environment: { ... }
   STRIPE_SECRET_KEY: stripeSecretKey.unsafeUnwrap(),
   STRIPE_WEBHOOK_SECRET: stripeWebhookSecret.unsafeUnwrap(),
   APP_BASE_URL: '<the deployed web app URL>',
   ```

   This isn't in the code yet because referencing secrets that don't exist fails the deploy.
3. In Stripe, add a webhook endpoint at `<API URL>/webhooks/stripe` for `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
4. Set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in the web app's build environment.
5. Register the web app's domain under [Payment method domains](https://dashboard.stripe.com/settings/payment_method_domains), in sandbox and live, or Apple Pay and Google Pay won't show.
6. In [Payment methods](https://dashboard.stripe.com/settings/payment_methods), turn off Link and Amazon Pay so the form shows Apple Pay, Google Pay and card only. Keep *Cards* on: the wallets run on it.

### Dependencies

- `stripe` (server), which defaults to API version `2026-10-28.endive` (Dahlia or later, as the embedded form needs).
- `@stripe/stripe-js` and `@stripe/react-stripe-js` (web). `loadStripe` loads Stripe.js from js.stripe.com at runtime; it's never bundled.

## New files

```
apps/api/src/services/billing/tableFee.ts       fee rules, session params, service
apps/api/src/services/billing/tableFee.test.ts  unit tests (fee choice, params, webhook)
apps/api/src/storage/tableFeeStore.ts           FEE#<billId> row in DynamoDB
apps/api/src/routes/billing.ts                  POST /v1/billing/table-fee, GET /v1/billing/table-fee/:billId
apps/api/src/routes/stripeWebhook.ts            POST /webhooks/stripe
packages/core/src/api/hooks/useTableFee.ts      useStartTableFee, useTableFeeStatus
apps/web/app/(app)/table-fee/[billId]/page.tsx  the embedded form page (F3)
```

## How it works

1. The lead opens `/table-fee/<billId>`. The page asks the API for a Checkout Session.
2. The API checks the bill is theirs and not already paid, picks `table_fee_2` or `table_fee_3` from the bill total, creates the session with the settings above plus the lead's email, `client_reference_id` and `metadata.billId`, and returns `{ client_secret }`.
3. The page mounts Stripe's embedded form (`CheckoutFormProvider` + `CheckoutForm`). The lead pays with Apple Pay, Google Pay or card; card details never leave Stripe's iframe.
4. On confirm, cards and wallets finish in place (`redirect: 'if_required'`). Anything that needs a redirect comes back to the same page with `?session_id=`.
5. Stripe calls `/webhooks/stripe`. After checking the signature, `checkout.session.completed` with `payment_status: paid` writes the `FEE#<billId>` row. A repeated event writes nothing.
6. The page polls `GET /v1/billing/table-fee/<billId>` until it says `paid`, then returns the lead to the bill.

## Testing

| Scenario | Card number |
|----------|-------------|
| Payment succeeds | 4242 4242 4242 4242 |
| Needs 3D Secure | 4000 0025 0000 3155 |
| Declined | 4000 0000 0000 9995 |

Any future expiry date and any CVC. Wallet buttons need HTTPS and a registered domain, so test them on the deployed dev site or through a tunnel.

Unit tests: `npm test -w apps/api` (`tableFee.test.ts` covers the £100 boundary, the session settings, ownership, paying twice, and webhook signing and repeats).

## Next steps

- [ ] Link to the page: F2's *Pay £3 fee & get QR code* goes to `/table-fee/<billId>`. Nothing links there yet.
- [ ] Gate sharing: `POST /v1/sessions` should need the free bill or a paid fee, behind `PAYWALL_ENABLED` (epic PR 1).
- [ ] Refund the fee automatically when a bill is closed or abandoned before any guest joins.
- [ ] Guests' share of the fee in what they owe (split what's left).
- [ ] e2e: stub the embedded form in `FakeApi` and cover pay → share.
- [ ] Before live: live keys, live webhook endpoint, live prices and domain registration.

## Resources

- https://support.stripe.com
- https://docs.stripe.com/mcp
- https://docs.stripe.com/checkout/form/quickstart
