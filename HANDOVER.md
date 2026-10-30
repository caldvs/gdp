# Handover

_Where the work is right now. Rewrite this when you finish something; don't append history._

_Last updated 1 Nov 2026._

## State of main

- **The app** is the Option D web UI. The whole flow is built: scan → check the bill → bank details → table fee (when Stripe is configured) → QR → guests claim and split → pay the lead → lead closes → everyone's emailed a report. See the [README](README.md) and [decisions](docs/decisions.md).
- **Bill reading** is Claude Haiku 4.5 on Bedrock, with Gemini as the fallback.
- **The dev API deploys** from `main` through GitHub Actions (OIDC). Dev and prod share one AWS account. Each has its own deploy role, trusted only by jobs in its GitHub environment; the dev job redeploys both role stacks. There's no staging; prod (`GdpBackendProd`) is defined but not deployed (setup steps in [docs/deploy.md](docs/deploy.md)). TrueLayer is off unless `TRUELAYER_ENABLED=true`. The web app is on Vercel (`web-nqib`), with Vercel Analytics.
- **Tests and CI:** one workflow, `.github/workflows/ci.yml`, runs on every PR and push to main and ends in a single `gate` check. Unit, integration and the Playwright e2e suite (against `FakeApi`) all run in it. Visual baselines are CI's.
  - **Coverage gate:** API (unit + integration together) is at ~86% lines / 70% branches, core at ~39% / 52%. Floors are in each `vitest.config.ts` (API 85/68, core 39/50, 100% on the money files). A PR fails if lines or branches drop more than 1 point below main; main's numbers live on the `coverage-baseline` branch and every PR gets a coverage comment. `coverage-drop-ok` label for a deliberate drop.
  - **Merging:** only with `scripts/merge-pr.sh <pr>`, which refuses unless `gate` passed on an up-to-date branch. GitHub can't enforce it (private repo, free plan).
  - Property tests (fast-check) pin the money maths: client and server agree on every split, a complete bill is charged to the penny.
  - Known bugs are written as `it.fails` in `apps/api/tests/integration/rules-and-races.test.ts`: fix one and its test starts failing, so change it to `it` in the same PR.
- **After each deploy** CI runs the smoke test and the dependency check (Stripe, Bedrock, Gemini, Places, SES from inside the Lambda; see [docs/deploy.md](docs/deploy.md)). The `gdp-dev` dashboard has a Calls out panel timing every outside call.
- **Secrets** aren't in the Lambda's configuration: it gets their names (`SECRET_SOURCES`) and reads them at cold start (`src/config/runtimeSecrets.ts`), so a rotated secret needs no redeploy. A missing secret fails the smoke test and dependency check.
- **Environments** are named everywhere: `APP_ENV` (API: local | dev | prod; Lambdas run `NODE_ENV=production`) and `NEXT_PUBLIC_APP_ENV` (web). The web build fails without an API URL or with the wrong kind of Stripe key, and the dependency check fails on a Stripe secret key of the wrong mode. See the Environments table in [docs/deploy.md](docs/deploy.md).

## Next up

**Environments rollout**, planned in the Claude project doc _environments-rollout-plan_: dev and prod each paired across Vercel, AWS and Stripe. Phases 1, 2 and 4 are done (deploy role, `APP_ENV`, key-mode and web build checks, secrets read at cold start), and prod's deploy role exists in the same account. Waiting on Callum: the GitHub `prod` environment and prod's SSM parameters and secrets (docs/deploy.md, _Setting up prod_), Stripe live activation, and a domain (phase 3). Limit the GitHub `dev` environment to `main` (the session proxy can't change environment settings).

**Analysis cache**, designed in [docs/design/analysis-cache.md](docs/design/analysis-cache.md), not built. Callum to decide first: a global cache or one per user. Bills now record the model that actually read them (`parsedFrom.parser` is Gemini's model when the fallback answered), so cache keys can use it.

## Known problems

- `close` doesn't release `BILLLOCK#` (only `abandon` does), so a closed bill can't be shared again. (`it.fails` test.)
- Two guests claiming the last unit at the same moment can both get it: `setClaims` is read-check-write with no condition on the write. (`it.fails` test.)
- Removing a split line from the bill leaves its split behind. (`it.fails` test.)
- Amending the bill while guests are claiming can remove or re-price a line a guest has already paid for. Proposed rule, waiting on Callum: a guest's lines freeze once they've paid (see `claude/test-and-coverage-plan.md` in the Claude project).
- The _change_ buttons for service and tax on Review bill are 32px, under the 44px tap target; allow-listed in `apps/web/e2e/layout.spec.ts` until the next visual-baseline refresh.
- `sessionStore.create` writes META's `ttlAt` as an ISO string; DynamoDB TTL ignores it until a later META write.
- The API still accepts claim changes after a guest has paid. (`it.fails` test.)
- Only quantity-1 items can be split.
- SES is in the sandbox: sign-in codes and reports only reach verified addresses. Emails should move to the site's own domain once there is one.
- Google Places returns 403 PERMISSION_DENIED: enable Places API (New) for the key's Google Cloud project, or loosen its API restrictions. Venues fall back to the text on the bill.
- Gemini's free tier allows 20 reads a day, so the fallback is easily used up.
- Nothing has been tried on a real phone with a real Bedrock read since the switch. Bedrock access (use-case form, Marketplace subscription) was completed on 1 Nov.

## Decided, not built

- Accounts optional: guests join with just a name (needs API work).
- Top-ups: more than one payment per guest, so _I had something else_ can reopen picking after paying.
- The lead assigning items to other people.
- Bill totals on `GET /v1/me/sessions`.
- Table fee: free bill a month, guests repay it, refund if nobody joins, server-side gate. See [docs/table-fee.md](docs/table-fee.md).

## Housekeeping

- `pr-screenshots` (PR images) and `coverage-baseline` (main's coverage numbers, written by CI) are orphan branches; keep them. Delete other branches once their PR is merged.
