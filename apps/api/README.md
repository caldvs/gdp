# API (`apps/api`)

Hono on Node 22, run as one AWS Lambda behind API Gateway, with a single DynamoDB table and an S3 bucket for bill photos. Infrastructure is CDK (`infra/main.ts`). Run `npm install` from the repo root, not here.

- `openapi.yaml` is the contract. After changing it, run `npm run gen:api` from the root to regenerate the client types.
- The running API serves its docs: `/swagger` (Swagger UI, with _Try it out_ against that server; _Authorize_ takes a session JWT) and `/docs` (Redoc, read-only). Locally: http://localhost:3000/swagger.
- The diagrams in [`docs/architecture`](../../docs/architecture/README.md) show every route, AWS resource and DynamoDB item.

## Layout

```
src/routes/     one file per route group (auth, me, bills, sessions, payments, billing, webhooks, ops)
src/services/   the logic: auth, bills (upload, parse, amend), sessions, payments, billing, email
src/storage/    one store per DynamoDB item type, plus S3
src/middleware/ request id, logging, auth, idempotency, errors
src/local.ts    the local server; src/lambda.ts is the Lambda entry
infra/          CDK stacks: GdpBackendDev (the app) and GdpGithubDeploy (CI's deploy role)
scripts/        dev bootstrap, smoke tests, bundle check
tests/          integration tests (real DynamoDB Local and MinIO)
```

## Running locally

From the repo root, `npm run dev:local` starts this and the web app. On its own:

```bash
cp .env.example .env.local     # set AWS_PROFILE to a profile that can call Bedrock
npm run dev                    # docker compose up (DynamoDB Local :8000, MinIO :9000), create table + bucket, watch src/local.ts on :3000
```

Locally:

- `POST /v1/auth/email/dev-sign-in` lets you sign in with just an email. It only exists against a local DynamoDB; turn it off with `AUTH_DEV_EMAIL_SIGNIN=false`.
- Bill reading uses Bedrock with your AWS profile (`AWS_PROFILE`, `BEDROCK_MODEL_ID`). Without them, scans fail with a clear error.
- Venue lookup is off (`VENUE_LOOKUP=none`): the venue is what Bedrock read off the bill. Set `amazon-location` to try the real lookup.
- Emails go to the console instead of SES.
- Payments use the `mock` provider by default.

`npm run ddb:down` stops the containers; `docker compose down -v` also wipes the data.

## Tests

```bash
npm test             # unit
npm run test:int     # integration, needs `npm run ddb:up`
npm run typecheck
npm run lint
npm run openapi:lint
```

## Deploying

```bash
npm run deploy:dev   # bundle check → cdk deploy GdpBackendDev → smoke test
npm run smoke -- https://<api-url>   # smoke-test any deployed API
```

`deploy:dev` uses the `gdp-dev` AWS profile and needs the secrets and parameters listed in `infra/main.ts`. CI deploys on every push to `main` once its role exists: see [`docs/deploy.md`](../../docs/deploy.md).

When an alarm fires: [`RUNBOOK.md`](RUNBOOK.md).

## Deployed config

| Setting     | Dev value                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------- |
| Region      | eu-west-2                                                                                   |
| Bill reader | Bedrock `eu.anthropic.claude-haiku-4-5-20251001-v1:0` (override with `-c bedrockModelId=…`) |
| Venue       | Amazon Location Service lookup, cached in `VENUEQ#` rows with no TTL                        |
| Payments    | `manual`: guests transfer, the lead confirms                                                |
| Email       | SES, from the address in SSM                                                                |
| Secrets     | Secrets Manager `gdp-dev/*`; plain config in SSM                                            |
| Logs        | CloudWatch, one month; dashboard `gdp-dev`                                                  |
