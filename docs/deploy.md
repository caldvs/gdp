# Deploying

Both halves are served over HTTPS with no certificates to manage:

| Part | Host                                         | URL                                                |
| ---- | -------------------------------------------- | -------------------------------------------------- |
| API  | API Gateway + Lambda (CDK, `apps/api/infra`) | `https://<id>.execute-api.eu-west-2.amazonaws.com` |
| Web  | Vercel (Next.js, `apps/web`)                 | `https://<project>.vercel.app`                     |

HTTPS matters for more than looks: the camera (`getUserMedia`) and the Web
Share/Clipboard APIs only work in a secure context, so the app can't be tried
on a phone over plain HTTP.

## Environments

Each environment pairs one of each, and nothing in one row may reach another.
`APP_ENV` (API) and `NEXT_PUBLIC_APP_ENV` (web) say which row a build is in;
the checks below fail a deploy or build that crosses rows.

| Env   | Web                         | API                                 | Stripe  | GitHub environment |
| ----- | --------------------------- | ----------------------------------- | ------- | ------------------ |
| local | `next dev` :8081            | Hono :3000, DynamoDB Local, MinIO   | Sandbox | —                  |
| CI    | `next start` + `FakeApi`    | Docker integration tests            | —       | —                  |
| dev   | Vercel Preview, `test.paymeback.dev` | `GdpBackendDev`, `api.test.paymeback.dev` | Sandbox | `dev`  |
| prod  | Vercel Production, `paymeback.dev`   | `GdpBackendProd`, `api.paymeback.dev`     | Live    | `prod` |

Vercel Production has no Stripe key until Stripe goes live (#79), so it shows no platform fee.

## Domains

`paymeback.dev` was bought on Vercel, and its DNS lives there (no Route 53). Diagrams of how it fits together: [architecture/domains.md](architecture/domains.md).

| Name | Points at |
| --- | --- |
| `paymeback.dev` | Vercel Production |
| `www.paymeback.dev` | 308 to `paymeback.dev` |
| `test.paymeback.dev` | Vercel Preview, branch `preview` (push to it to put something there); its builds call `api.test.paymeback.dev` |
| `api.paymeback.dev` | `GdpBackendProd` (custom domain on API Gateway; CNAME to `d-pujffkifc1…`) |
| `api.test.paymeback.dev` | `GdpBackendDev` (CNAME to `d-b8lxm0scy5…`) |

**API domains (once per environment).** CDK can't validate a certificate in
Vercel DNS, so this part is by hand:

1. ACM (eu-west-2) → Request a public certificate for `api.test.paymeback.dev`
   (or `api.paymeback.dev`), DNS validation.
2. Vercel → Domains → `paymeback.dev` → DNS: add the CNAME ACM shows (name
   without the `.paymeback.dev` suffix). Wait for *Issued*.
3. GitHub environment (`dev` or `prod`) → variables `API_DOMAIN` and
   `API_CERT_ARN`. Redeploy the API.
4. Vercel DNS: CNAME `api.test` (or `api`) → the deploy's
   `ApiDomainTargetOutput` (`d-….execute-api.eu-west-2.amazonaws.com`).
5. Point `NEXT_PUBLIC_API_BASE_URL` (Vercel) and the Stripe webhook at the new
   name.

**CORS.** The API and the bills bucket accept only the origins in
`apps/api/src/config/allowedOrigins.ts`: for prod, `paymeback.dev` and
`web-nqib.vercel.app`; for dev, `test.paymeback.dev`, preview URLs and
`localhost:8081`. Local runs (no `ALLOWED_ORIGINS`) allow any origin.

Dev and prod share one AWS account (eu-west-2). Every resource is named per
environment (`gdp-dev`, `gdp-prod`, …) and each Lambda can only read its own
`gdp-<env>/*` secrets. Deploys are kept apart by GitHub: each deploy role
(`gdp-github-deploy`, `gdp-github-deploy-prod`) is trusted only by jobs in its
own GitHub environment, and the workflow refuses a prod deploy from anything
but `main`. Both roles can use the account's CDK bootstrap roles, so AWS
itself doesn't separate them; a second account would.

### Setting up prod (one-off)

The deploy roles' stacks (`GdpGithubDeploy`, `GdpGithubDeployProd`) deploy
from the prod job only (#144), so a push to main can't change either role's
trust policy. Setting up from scratch, create them once from your Mac
(`npx cdk deploy GdpGithubDeploy GdpGithubDeployProd -c githubOidcProviderArn=…`,
see the comment in `deploy-api.yml`). Then:

1. GitHub → Settings → Environments → **New environment** `prod`: required
   reviewer (Callum), deployment branches `main` only, and variables
   `AWS_DEPLOY_ROLE_ARN` (the prod role's ARN), `AWS_REGION` = `eu-west-2`,
   `APP_BASE_URL` (the web app's prod URL). Leave `STRIPE_ENABLED` unset until
   Stripe live is ready. Optional **secret** (never a variable: run logs are
   public) `TABLE_FEE_EXEMPT_EMAILS`: emails that never pay the platform fee
   and sign in with no link (docs/table-fee.md).
2. In eu-west-2: the SSM parameter `/gdp-prod/ses-from-email` (the same
   verified sender as dev works; it's one account) and the secret
   `gdp-prod/session-jwt-secret` (new, random, 32+ characters). A missing SSM
   parameter fails the deploy; a missing secret fails the smoke test.
3. Actions → **Deploy to prod** → Run workflow, and approve the prod deploy.

What enforces it:

- **Web build** (`packages/core/src/lib/buildEnv.ts`, run by `next.config.ts`):
  `NEXT_PUBLIC_APP_ENV` must be set on Vercel; dev and prod need an https
  `NEXT_PUBLIC_API_BASE_URL`; the Stripe publishable key is `pk_test_` outside
  prod and `pk_live_` in prod.
- **API deploy** (dependency check, `src/ops/selfCheck.ts`): the Stripe secret
  key is test-mode outside prod and live-mode in prod.
- **Deploy role** (`infra/githubDeploy.ts`): trusts only jobs in its own GitHub
  environment.

## API

### Deploy now, from your Mac

```bash
npm run deploy:dev -w apps/api   # validate → cdk deploy GdpBackendDev → smoke
```

Uses the `gdp-dev` AWS profile. The SSM parameters and Secrets Manager
secrets listed in `apps/api/infra/main.ts` must exist in eu-west-2.

### Let Actions deploy dev (one-off)

`.github/workflows/deploy-api.yml` deploys with GitHub OIDC. To give it a role:

1. `cd apps/api && npx cdk deploy GdpGithubDeploy --profile gdp-dev`
   - If the account already has a GitHub OIDC provider (the deploy fails
     with "already exists"), add
     `-c githubOidcProviderArn=arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com`.
2. GitHub → caldvs/gdp → Settings → Environments → **New environment** `dev`,
   then add two variables:
   - `AWS_DEPLOY_ROLE_ARN` = the stack's `DeployRoleArnOutput`
     (`arn:aws:iam::<acct>:role/gdp-github-deploy`)
   - `AWS_REGION` = `eu-west-2`
3. Actions → **Deploy API** → Run workflow (`dev`) to check it.

The role can only assume the CDK bootstrap roles (`cdk-*`), and only from jobs
in this repo's `dev` GitHub environment (`repo:caldvs/gdp:environment:dev`, or
the same with owner and repo IDs, which is what GitHub now sends). Limit the
`dev` environment to the `main` branch so only `main` can deploy.
The API stack also lets it invoke the API function, for the dependency check below.

After step 1, CI keeps the role stack up to date: the dev deploy job redeploys
`GdpGithubDeploy` as its last step. If a change to its trust locks CI out, rerun
step 1 from your Mac.

### Turn on sign-in by text (#231)

Sign-in codes go by text through AWS End User Messaging SMS, in eu-west-2.
Once, in the AWS console (End User Messaging → SMS):

1. **Request production access** (Account → *Request production access*):
   transactional, UK, one-time sign-in codes, low volume. Until it's
   granted the account is in the sandbox and texts only numbers verified
   under *Verified destination numbers*, which is enough to try it.
2. **Set the monthly SMS spend limit** (new accounts start at $1).
3. **Request a sender ID** (*Phone numbers* → *Request originator* → Sender
   ID, United Kingdom): `PayMeBack`. No registration for an unprotected
   name.

4. **UK only** (done 8 Nov): the account's default protect configuration
   (`protect-359d04393d6d44dfb233e0a8784a1614`) blocks texts to every
   country but GB, so a bot can't run up a bill on foreign premium numbers.

Alarms (CDK, when `SMS_SENDER_ID` is set): over 100 sign-in codes in an
hour, and (prod's stack, account-wide) SMS spend past $15 this month.

Then set the GitHub environment variable `SMS_SENDER_ID=PAYMEBACK` (dev
first) and deploy. `GET /v1/auth/methods` then says `sms: true` and Sign in
asks for a mobile number. Without it, sign-in stays email only.

### Turn on WhatsApp (#229, #230)

Off until the Meta app exists. Once you have its details:

```bash
for s in phone-number-id access-token app-secret verify-token; do
  aws secretsmanager create-secret --profile gdp-dev --region eu-west-2 \
    --name "gdp-dev/whatsapp-$s" --secret-string "<value>"
done
```

Then set the `dev` environment variable `WHATSAPP_ENABLED=true` (GitHub →
Settings → Environments → dev) and deploy. In the Meta app, subscribe the
webhook to `https://<dev api>/webhooks/whatsapp` with the same verify token,
field `messages`. Without the secrets the webhook isn't mounted and messages
go to the console logger.

### Checks after every deploy

The workflow runs two checks once `cdk deploy` finishes:

- **Smoke test** (`scripts/smoke.ts`): health, readiness, the auth gate and
  the docs, over HTTPS, through the stack's custom domain
  (`ApiDomainUrlOutput`: `api.paymeback.dev`, `api.test.paymeback.dev`) when it
  has one, so a broken DNS record or certificate fails the deploy.
- **Dependency check** (`scripts/deps-check.ts`): invokes the deployed
  function with `{"gdpSelfCheck":true}` so it checks, with its own config
  and IAM role, that the Stripe key works, that a hold can be placed and
  released (test mode only: a £1 `pm_card_visa` hold released by the same code
  that releases a bill nobody joined, and another with 66p taken as at close,
  so each dev deploy leaves one cancelled £1 hold and one 66p payment in the
  Stripe sandbox, described *Deploy smoke test*; skipped with a live key), Bedrock
  answers, Amazon Location can look up a UK place, and the SES sender is
  verified (and whether SES is still in the sandbox). Stripe, Bedrock and SES
  failing fail the run; Amazon Location only warns, because a failed lookup
  leaves the venue as read off the bill. The results table is in the run's
  summary.

Run it yourself with `AWS_PROFILE=gdp-dev npm run check:deps -w apps/api <function-name>`
(the name is the stack's `ApiFunctionNameOutput`).

Every call out to Bedrock, Amazon Location, Stripe and SES is logged as
`event: dep.call` with its duration; the dashboard's **Calls out** panel
shows count, failures, average, p95 and max for each.

## Web (Vercel)

One-off, in the Vercel dashboard:

1. **Add New → Project**, import `caldvs/gdp`.
2. **Root Directory:** `apps/web`. Framework is detected as Next.js; leave
   build and install commands as default (Vercel installs from the repo root
   because of the npm workspaces).
3. **Environment variables** (Production and Preview):
   - `NEXT_PUBLIC_APP_ENV` = `dev` (Production becomes `prod` at cutover)
   - `NEXT_PUBLIC_API_BASE_URL` = the API's `ApiUrlOutput` (no trailing slash)
   - `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` = `pk_test_…` (`pk_live_…` for prod)

   The build fails if these don't match (see Environments above).

4. **Settings → Tokens:** create a token and add it to the repo as the
   `VERCEL_TOKEN` Actions secret.

Git pushes never deploy (`apps/web/vercel.json` switches Git deploys off):
Hobby allows 100 deployments a day and every push counts. GitHub Actions
deploys instead (#124):

- **Test:** pushes to main deploy nothing themselves. When a push's Checks pass on main (and hourly at :17 as a backstop, since GitHub runs schedules hours late, #232) **Deploy to test**
  (`deploy-test.yml`) takes the newest commit on main whose `gate` passed,
  compares it with the last `test` deployment (Settings → Environments; what test runs now) and deploys only
  what changed: the dev API (Deploy API, `dev`) for `apps/api`, and for
  `apps/web` or `packages` a Vercel Preview build (Preview env vars: the dev
  API) aliased to `test.paymeback.dev`. Then it records a `test` deployment. Nothing new
  deploys nothing, so test costs one Vercel deploy per green web change. Run it
  by hand to deploy now (`force` redeploys both). If a deploy fails the tag
  stays put and the next hour retries, so fix main.
- **Live:** Actions → **Deploy to prod** → Run workflow (optionally a commit on main;
  blank means latest). It refuses a commit whose `gate` didn't pass, deploys
  the prod API (`GdpBackendProd`; the `prod` environment's reviewer approves),
  stops if the smoke test or dependency check fails, then builds and deploys
  paymeback.dev from the same commit and records it as a `live` deployment named `release-YYYY-MM-DD-n` (GitHub deployments, not tags: the Actions token can't create a tag on a commit that changed a workflow) with
  a summary of what changed since the last release. The prod API never
  deploys any other way, so the live site can't get ahead of the API it
  needs.
- **Rollback:** the web app with Vercel's Instant Rollback (no build); the
  API by running Deploy to prod on the previous `live` deployment's commit.
- Vercel cost: one deploy per web push plus one per release.

`NEXT_PUBLIC_PUBLIC_BASE_URL` is optional: share links and QR codes fall back
to the page's own origin, which is right on Vercel.

## After the first deploy

- **SES sandbox.** New SES accounts only send to verified addresses, so
  guests can't receive sign-in codes. `paymeback.dev` is verified and
  production access was requested on 2 Nov 2026: see [email.md](email.md)
  for the setup, the status and what to do once it's approved.
- **Alerts.** Subscribe to the alarm topic (see `apps/api/RUNBOOK.md`).
- **Bedrock model access.** Enable Claude Sonnet 4.6 in the Bedrock console
  (eu-west-2), or no bill can be read.
- **Platform fee.** Stripe setup is in [table-fee.md](table-fee.md).
- **Real-device check.** Scan a real bill on a phone against the deployed
  API.
