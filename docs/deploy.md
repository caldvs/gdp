# Deploying

Both halves are served over HTTPS with no certificates to manage:

| Part | Host                                         | URL                                                |
| ---- | -------------------------------------------- | -------------------------------------------------- |
| API  | API Gateway + Lambda (CDK, `apps/api/infra`) | `https://<id>.execute-api.eu-west-2.amazonaws.com` |
| Web  | Vercel (Next.js, `apps/web`)                 | `https://<project>.vercel.app`                     |

HTTPS matters for more than looks: the camera (`getUserMedia`) and the Web
Share/Clipboard APIs only work in a secure context, so the app can't be tried
on a phone over plain HTTP.

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

The role can only assume the CDK bootstrap roles (`cdk-*`), and only from
workflow runs in this repo (`repo:caldvs/gdp:*`, or the same with owner and repo IDs, which is what GitHub now sends).
The API stack also lets it invoke the API function, for the dependency check below.

### Checks after every deploy

The workflow runs two checks once `cdk deploy` finishes:

- **Smoke test** (`scripts/smoke.ts`): health, readiness, the auth gate and
  the docs, over HTTPS.
- **Dependency check** (`scripts/deps-check.ts`): invokes the deployed
  function with `{"gdpSelfCheck":true}` so it checks, with its own config
  and IAM role, that the Stripe key works and both fee prices exist, Bedrock
  answers, the Gemini and Places keys are accepted, and the SES sender is
  verified (and whether SES is still in the sandbox). Stripe, Bedrock and
  SES failing fail the run; Gemini and Places are fallbacks or extras, so
  they show as warnings. The results table is in the run's summary.

Run it yourself with `AWS_PROFILE=gdp-dev npm run check:deps -w apps/api <function-name>`
(the name is the stack's `ApiFunctionNameOutput`).

Every call out to Bedrock, Gemini, Places, Stripe and SES is logged as
`event: dep.call` with its duration; the dashboard's **Calls out** panel
shows count, failures, average, p95 and max for each.

## Web (Vercel)

One-off, in the Vercel dashboard:

1. **Add New → Project**, import `caldvs/gdp`.
2. **Root Directory:** `apps/web`. Framework is detected as Next.js; leave
   build and install commands as default (Vercel installs from the repo root
   because of the npm workspaces).
3. **Environment variables** (Production and Preview):
   - `NEXT_PUBLIC_API_BASE_URL` = the API's `ApiUrlOutput` (no trailing slash)
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
  (eu-west-2), or every bill falls back to Gemini.
- **Table fee.** Stripe setup is in [table-fee.md](table-fee.md).
- **Real-device check.** Scan a real bill on a phone against the deployed
  API.
