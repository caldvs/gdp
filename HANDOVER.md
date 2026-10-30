# Handover

_Where the work is right now. Rewrite this when you finish something; don't append history._

_Last updated 1 Nov 2026._

## State of main

- **The app** is the Option D web UI. The whole flow is built: scan → check the bill → bank details → table fee (when Stripe is configured) → QR → guests claim and split → pay the lead → lead closes → everyone's emailed a report. See the [README](README.md) and [decisions](docs/decisions.md).
- **Bill reading** is Claude Sonnet 4.6 on Bedrock (both calls: finding the receipt and reading it) and nothing else: no fallback reader, no Google services. Locally it uses your `AWS_PROFILE`. The app uploads photos up to 3200px; the API asks the model where the receipt is, crops to it, and sends a long one as up to 4 overlapping parts in one call (`receiptImages.ts`, pure-JS `jpeg-js`). The model copies each line's printed total and quantity; the API works out unit prices (`splitTotal`, two lines when it doesn't divide evenly). Minus lines (deals, comps) are folded into the item they came from, or shared by price when the reader can't tell which (`discounts.ts`); deposits are left out and the total is the pre-deposit one. It runs in the background: the app uploads, calls `POST /v1/bills/reads`, and the Lambda invokes itself to read (45s budget). `/reading/[id]` polls it and opens Review bill when done; the lead can go back to Bills, which shows the read as a row (kept in this browser's storage). A failed read keeps the photo with *Try again* (same upload, no re-upload) and *New photo*. The synchronous `POST /v1/bills/parse` still works, with 22s to fit API Gateway's 30s (504 `PARSE_TIMEOUT` when it runs out).
- **Venue:** Bedrock reads the name and printed address off the bill; Amazon Location Service then fills in the full address and coordinates (`VENUE_LOOKUP=amazon-location` when deployed, `none` locally). Lookups are cached for good in `VENUEQ#` rows. Old Google Places rows in dev are replaced on their next lookup.
- **Loading screens:** reading a bill shows the photo as a thumbnail beside the title and grey bill rows (`BillSkeleton` in `ui.tsx`), which Review bill also shows while it loads. After the table fee is paid, two stages tick off: payment, then QR code (`Steps` in `ui.tsx`).
- **The dev API deploys** from `main` through GitHub Actions (OIDC). Dev and prod share one AWS account. Each has its own deploy role, trusted only by jobs in its GitHub environment; the dev job redeploys both role stacks. There's no staging; prod (`GdpBackendProd`) is defined but not deployed (setup steps in [docs/deploy.md](docs/deploy.md)). TrueLayer is off unless `TRUELAYER_ENABLED=true`. The web app is on Vercel (`web-nqib`), with Vercel Analytics.
- **Tests and CI:** one workflow, `.github/workflows/ci.yml`, runs on every push to main (and on any PR, though work now goes straight to main) and ends in a single `gate` check. Unit, integration and the Playwright e2e suite (against `FakeApi`) all run in it. Visual baselines are CI's.
  - **Coverage:** API (unit + integration together) is at ~86% lines / 70% branches, core at ~39% / 52%. Floors are in each `vitest.config.ts` (API 85/68, core 39/50, 100% on the money files). Main's numbers live on the `coverage-baseline` branch.
  - **No pull requests** (Callum, 1 Nov 2026): work is committed and pushed straight to `main` after running the checks locally; if `gate` or the deploy fails, fix or revert on main at once. The repo is public, so Actions minutes are free.
  - Property tests (fast-check) pin the money maths: client and server agree on every split, a complete bill is charged to the penny.
  - Known bugs are written as `it.fails` (none open now): fix one and its test starts failing, so change it to `it` in the same commit.
- **Testing as several people:** local and dev builds show a test bar above the header. It signs in as alice/bob/charlie/diana or a new guest (`@test.invalid`, no code) and keeps the switch to that tab by default, so the lead and a guest can share a window. API side is `POST /v1/auth/email/test-sign-in`, on locally and on dev (`AUTH_TEST_ACCOUNTS`), off in prod (the dependency check fails if not). The sign-in page's old local-only "Dev accounts" buttons are gone; the local no-code sign-in for any email is unchanged. Locally the bar also has *Skip bill cache*: uploads and reads send `skipCache`, so a photo this account has read before goes to Bedrock again and becomes a new bill (only the local API honours it). The bar shows on paymeback.dev too, which it shouldn't (#98).
- **Daily cost email:** stack `GdpCostReport` (one per account, deployed by the dev job) emails Callum (address in SSM `/gdp/cost-report-to`) at 07:00 UTC with yesterday's and the month's AWS costs by service, plus a forecast (`src/ops/costReport.ts`). Two Cost Explorer calls a day at $0.01 each. In the SES sandbox the address must stay verified.
- **After each deploy** CI runs the smoke test and the dependency check (Stripe, Bedrock, SES and test accounts off in prod, from inside the Lambda; see [docs/deploy.md](docs/deploy.md)). The `gdp-dev` dashboard has a Calls out panel timing every outside call.
- **Secrets** aren't in the Lambda's configuration: it gets their names (`SECRET_SOURCES`) and reads them at cold start (`src/config/runtimeSecrets.ts`), so a rotated secret needs no redeploy. A missing secret fails the smoke test and dependency check.
- **Environments** are named everywhere: `APP_ENV` (API: local | dev | prod; Lambdas run `NODE_ENV=production`) and `NEXT_PUBLIC_APP_ENV` (web). The web build fails without an API URL or with the wrong kind of Stripe key, and the dependency check fails on a Stripe secret key of the wrong mode. See the Environments table in [docs/deploy.md](docs/deploy.md).

## On branch `design/tinted-storybook` (not merged)

- **Tinted page:** the page is a pale grey-blue (`--page`), header, action bar and menu stay white, and boxes, stats, card rows and the QR box are white cards with a soft border and shadow. Tokens are in `apps/web/app/globals.css`. Every screen changes, so the visual baselines need regenerating (run _Update visual baselines_ on the branch) before `gate` goes green.
- **Storybook** in `apps/web`: `npm run storybook -w apps/web` (port 6006), `npm run build-storybook -w apps/web` for a static build. Stories are in `apps/web/stories/`: every piece in `ui.tsx`, the form classes, the header, the join QR and three whole screens. `BillTools`, `Scanner` and `DemoBanner` need the API or the camera and have no stories yet. Not run in CI.

## Exempt accounts (PR open)

On `feat/fee-exempt`: emails in the GitHub environment's `TABLE_FEE_EXEMPT_EMAILS` (secret or variable, comma separated) skip the table fee (`waived`) and sign in with no code. Set it on `dev` and `prod`, then redeploy the API. Link sign-in instead of codes is backlog #119.

## Next up

**Environments rollout**, planned in the Claude project doc _environments-rollout-plan_: dev and prod each paired across Vercel, AWS and Stripe. Phases 1, 2 and 4 are done, and prod's API is deployed. **Domain:** `paymeback.dev` (DNS on Vercel) serves Production, `test.paymeback.dev` serves the `preview` branch. API CORS is now an allow-list per stage (`src/config/allowedOrigins.ts`), and CDK adds `api.paymeback.dev` / `api.test.paymeback.dev` once the ACM certificates exist (by hand: docs/deploy.md, _Domains_). Then: cut Production over to the prod API (#78; remove the two cut-over origins from the dev list), Stripe live (#79), SES on the domain (#76).

**Scanning a bill (#66)**: #59 (in-app camera with a bill guide) and #60 (*All in?* photo check) are on `feat/scan-camera`. Still to try on a real iPhone and Android phone with a long receipt: if small print reads worse than with the phone's own camera, raise the resolution before merging. Next in #66: #65 (review flags), then #62/#63 (venue), #61 (questions while reading), #64 (party size).

**Analysis cache**, designed in [docs/design/analysis-cache.md](docs/design/analysis-cache.md), not built. Callum to decide first: a global cache or one per user. Bills record the model that actually read them (`parsedFrom.parser`), so cache keys can use it.

## Known problems

- Vercel Hobby allows 100 deployments a day (hit on 1 Nov). Pushes no longer deploy: production goes out hourly from `web-deploy.yml`, PR previews only with the `preview` label. Needs the `VERCEL_TOKEN` secret.
- One golden receipt so far (Gusto, a long receipt photographed as a narrow strip). With prompt v7 it reads to the penny; a size label sometimes lands on the neighbouring line and two quantities swap. Add more photos and their printed totals to `apps/api/fixtures/receipts/`, then `npm run golden -w apps/api`.
- Only quantity-1 items can be split.
- SES is in the sandbox: sign-in codes and reports only reach verified addresses. Emails should move to the site's own domain once there is one.
- Nothing has been tried on a real phone with a real Bedrock read since the switch. Bedrock access (use-case form, Marketplace subscription) was completed on 1 Nov.

## Decided, not built

- Accounts optional: guests join with just a name (needs API work).
- Top-ups: a guest who forgot something adds it after paying and pays again for the extra (confirmed 1 Nov). Adding claims after paying already works; a second payment per guest doesn't yet.
- The lead assigning items to other people.
- Bill totals on `GET /v1/me/sessions`.
- Table fee: one free bill a month per lead, then the fee is due at the QR (everything before it stays free); guests repay it, refund if nobody joins, server-side gate on `/share`. See [docs/table-fee.md](docs/table-fee.md).

## Housekeeping

- `pr-screenshots` (PR images) and `coverage-baseline` (main's coverage numbers, written by CI) are orphan branches; keep them. Each carries `apps/web/vercel.json` switching Vercel deploys off (CI writes it into `coverage-baseline`); keep that file if you rewrite either branch, or Vercel fails a build on every push. Other branches are leftovers from the PR days: delete them once nothing on them is needed.
