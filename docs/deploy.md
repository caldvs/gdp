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
| dev   | Vercel Preview (`web-nqib`) | `GdpBackendDev`                     | Sandbox | `dev`              |
| prod  | Vercel Production           | `GdpBackendProd` (not yet deployed) | Live    | `prod` (not yet)   |

Until prod exists, Vercel Production also runs as `dev` against the dev API.

Dev and prod share one AWS account (eu-west-2). Every resource is named per
environment (`gdp-dev`, `gdp-prod`, …) and each Lambda can only read its own
`gdp-<env>/*` secrets. Deploys are kept apart by GitHub: each deploy role
(`gdp-github-deploy`, `gdp-github-deploy-prod`) is trusted only by jobs in its
own GitHub environment, and the workflow refuses a prod deploy from anything
but `main`. Both roles can use the account's CDK bootstrap roles, so AWS
itself doesn't separate them; a second account would.

### Setting up prod (one-off)

The dev deploy job creates `gdp-github-deploy-prod` and prints its ARN in the
run summary. Then:

1. GitHub → Settings → Environments → **New environment** `prod`: required
   reviewer (Callum), deployment branches `main` only, and variables
   `AWS_DEPLOY_ROLE_ARN` (the prod role's ARN), `AWS_REGION` = `eu-west-2`,
   `APP_BASE_URL` (the web app's prod URL). Leave `STRIPE_ENABLED` unset until
   Stripe live is ready.
2. In eu-west-2: the SSM parameter `/gdp-prod/ses-from-email` (the same
   verified sender as dev works; it's one account) and the secret
   `gdp-prod/session-jwt-secret` (new, random, 32+ characters). A missing SSM
   parameter fails the deploy; a missing secret fails the smoke test.
3. Actions → **API Deploy** → Run workflow on `main` with `prod`, and approve.

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

### Let CI deploy on every push to main (one-off)

`.github/workflows/api-deploy.yml` deploys with GitHub OIDC. To give it a role:

1. `cd apps/api && npx cdk deploy GdpGithubDeploy --profile gdp-dev`
   - If the account already has a GitHub OIDC provider (the deploy fails
     with "already exists"), add
     `-c githubOidcProviderArn=arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com`.
2. GitHub → caldvs/gdp → Settings → Environments → **New environment** `dev`,
   then add two variables:
   - `AWS_DEPLOY_ROLE_ARN` = the stack's `DeployRoleArnOutput`
     (`arn:aws:iam::<acct>:role/gdp-github-deploy`)
   - `AWS_REGION` = `eu-west-2`
3. Actions → **API Deploy** → Run workflow (`dev`) to check it.

The role can only assume the CDK bootstrap roles (`cdk-*`), and only from jobs
in this repo's `dev` GitHub environment (`repo:caldvs/gdp:environment:dev`, or
the same with owner and repo IDs, which is what GitHub now sends). Limit the
`dev` environment to the `main` branch so only `main` can deploy.
The API stack also lets it invoke the API function, for the dependency check below.

After step 1, CI keeps the role stack up to date: the dev deploy job redeploys
`GdpGithubDeploy` as its last step. If a change to its trust locks CI out, rerun
step 1 from your Mac.

### Checks after every deploy

The workflow runs two checks once `cdk deploy` finishes:

- **Smoke test** (`scripts/smoke.ts`): health, readiness, the auth gate and
  the docs, over HTTPS.
- **Dependency check** (`scripts/deps-check.ts`): invokes the deployed
  function with `{"gdpSelfCheck":true}` so it checks, with its own config
  and IAM role, that the Stripe key works and both fee prices exist, Bedrock
  answers, and the SES sender is verified (and whether SES is still in the
  sandbox). Any of them failing fails the run. The results table is in the
  run's summary.

Run it yourself with `AWS_PROFILE=gdp-dev npm run check:deps -w apps/api <function-name>`
(the name is the stack's `ApiFunctionNameOutput`).

Every call out to Bedrock, Stripe and SES is logged as
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

4. Deploy. Every push to `main` then deploys production; every PR gets a
   preview URL.

`NEXT_PUBLIC_PUBLIC_BASE_URL` is optional: share links and QR codes fall back
to the page's own origin, which is right on Vercel.

## After the first deploy

- **SES sandbox.** New SES accounts only send to verified addresses, so
  guests can't receive sign-in codes. Request production access (SES console
  → Account dashboard), or verify each tester's address meanwhile.
- **Alerts.** Subscribe to the alarm topic (see `apps/api/RUNBOOK.md`).
- **Bedrock model access.** Enable Claude Haiku 4.5 in the Bedrock console
  (eu-west-2), or no bill can be read.
- **Table fee.** Stripe setup is in [table-fee.md](table-fee.md).
- **Real-device check.** Scan a real bill on a phone against the deployed
  API.
