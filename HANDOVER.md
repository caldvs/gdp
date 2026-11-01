# Handover

_Where the work is right now. Rewrite this when you finish something; don't append history._

_Last updated 1 Nov 2026._

## State of main

- **The app** is the Option D web UI. The whole flow is built: scan → check the bill → bank details → table fee (when Stripe is configured) → QR → guests claim and split → pay the lead → lead closes → everyone's emailed a report. See the [README](README.md) and [decisions](docs/decisions.md).
- **Bill reading** is Claude Haiku 4.5 on Bedrock and nothing else: no fallback reader, no Google services. Locally it uses your `AWS_PROFILE`.
- **Venue:** Bedrock reads the name and printed address off the bill; Amazon Location Service then fills in the full address and coordinates (`VENUE_LOOKUP=amazon-location` when deployed, `none` locally). Lookups are cached for good in `VENUEQ#` rows. Old Google Places rows in dev are replaced on their next lookup.
- **The dev API deploys** from `main` through GitHub Actions (OIDC). Dev and prod share one AWS account. Each has its own deploy role, trusted only by jobs in its GitHub environment; the dev job redeploys both role stacks. There's no staging; prod (`GdpBackendProd`) is defined but not deployed (setup steps in [docs/deploy.md](docs/deploy.md)). TrueLayer is off unless `TRUELAYER_ENABLED=true`. The web app is on Vercel (`web-nqib`), with Vercel Analytics.
- **Tests and CI:** one workflow, `.github/workflows/ci.yml`, runs on every PR and push to main and ends in a single `gate` check. Unit, integration and the Playwright e2e suite (against `FakeApi`) all run in it. Visual baselines are CI's.
  - **Coverage gate:** API (unit + integration together) is at ~86% lines / 70% branches, core at ~39% / 52%. Floors are in each `vitest.config.ts` (API 85/68, core 39/50, 100% on the money files). A PR fails if lines or branches drop more than 1 point below main; main's numbers live on the `coverage-baseline` branch and every PR gets a coverage comment. `coverage-drop-ok` label for a deliberate drop.
  - **Merging:** never merge a PR unless `gate` passed on its latest commit and the branch is up to date with main. GitHub can't enforce it (private repo, free plan), so it's a rule in `CLAUDE.md`.
  - Property tests (fast-check) pin the money maths: client and server agree on every split, a complete bill is charged to the penny.
  - Known bugs are written as `it.fails` (none open now): fix one and its test starts failing, so change it to `it` in the same PR.
- **Testing as several people:** local and dev builds show a test bar above the header. It signs in as alice/bob/charlie/diana or a new guest (`@test.invalid`, no code) and keeps the switch to that tab by default, so the lead and a guest can share a window. API side is `POST /v1/auth/email/test-sign-in`, on locally and on dev (`AUTH_TEST_ACCOUNTS`), off in prod (the dependency check fails if not). The sign-in page's old local-only "Dev accounts" buttons are gone; the local no-code sign-in for any email is unchanged.
- **After each deploy** CI runs the smoke test and the dependency check (Stripe, Bedrock, SES and test accounts off in prod, from inside the Lambda; see [docs/deploy.md](docs/deploy.md)). The `gdp-dev` dashboard has a Calls out panel timing every outside call.
- **Secrets** aren't in the Lambda's configuration: it gets their names (`SECRET_SOURCES`) and reads them at cold start (`src/config/runtimeSecrets.ts`), so a rotated secret needs no redeploy. A missing secret fails the smoke test and dependency check.
- **Environments** are named everywhere: `APP_ENV` (API: local | dev | prod; Lambdas run `NODE_ENV=production`) and `NEXT_PUBLIC_APP_ENV` (web). The web build fails without an API URL or with the wrong kind of Stripe key, and the dependency check fails on a Stripe secret key of the wrong mode. See the Environments table in [docs/deploy.md](docs/deploy.md).

## On branch `design/tinted-storybook` (not merged)

- **Tinted page:** the page is a pale grey-blue (`--page`), header, action bar and menu stay white, and boxes, stats, card rows and the QR box are white cards with a soft border and shadow. Tokens are in `apps/web/app/globals.css`. Every screen changes, so the visual baselines need regenerating (run _Update visual baselines_ on the branch) before `gate` goes green.
- **Storybook** in `apps/web`: `npm run storybook -w apps/web` (port 6006), `npm run build-storybook -w apps/web` for a static build. Stories are in `apps/web/stories/`: every piece in `ui.tsx`, the form classes, the header, the join QR and three whole screens. `BillTools`, `Scanner` and `DemoBanner` need the API or the camera and have no stories yet. Not run in CI.

## Next up

**Environments rollout**, planned in the Claude project doc _environments-rollout-plan_: dev and prod each paired across Vercel, AWS and Stripe. Phases 1, 2 and 4 are done (deploy role, `APP_ENV`, key-mode and web build checks, secrets read at cold start), and prod's deploy role exists in the same account. Waiting on Callum: the GitHub `prod` environment and prod's SSM parameters and secrets (docs/deploy.md, _Setting up prod_), Stripe live activation, and a domain (phase 3). Limit the GitHub `dev` environment to `main` (the session proxy can't change environment settings).

**Analysis cache**, designed in [docs/design/analysis-cache.md](docs/design/analysis-cache.md), not built. Callum to decide first: a global cache or one per user. Bills record the model that actually read them (`parsedFrom.parser`), so cache keys can use it.

## Known problems

- The _change_ buttons for service and tax on Review bill are 32px, under the 44px tap target; allow-listed in `apps/web/e2e/layout.spec.ts` until the next visual-baseline refresh.
- Five accessibility findings are allow-listed in `apps/web/e2e/a11y.spec.ts` (contrast on lines someone else took, aria-labels that don't contain the visible text, a colour-only link on the landing page). New ones fail CI.
- No golden receipts yet: add photos and their printed totals to `apps/api/fixtures/receipts/`, then `npm run golden -w apps/api`.
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

- `pr-screenshots` (PR images) and `coverage-baseline` (main's coverage numbers, written by CI) are orphan branches; keep them. Delete other branches once their PR is merged.
