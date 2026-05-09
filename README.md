# gdp-backend

Group Dine Pay backend API. TypeScript on Node 22, AWS Lambda + DynamoDB + S3, deployed via CDK.

## Requirements

- Node 22 (`nvm use`)
- Docker (for DynamoDB Local + LocalStack S3)
- An AWS account (only required at deploy time)

## Local development

```bash
nvm use
npm install
docker compose up -d              # DDB Local on :8000, LocalStack S3 on :4566
cp .env.example .env              # fill in secrets
npm run dev                       # http://localhost:3000
```

## Tests

```bash
npm test                          # unit tests
npm run typecheck
npm run lint
npm run openapi:lint
```

## Deploy

```bash
npm run deploy:dev                # validate locally → cdk deploy → smoke
```

`deploy:dev` chains three steps and aborts on the first failure:

1. `npm run validate:bundle` — runs `cdk synth`, locates the bundled
   Lambda asset, loads it in this Node process with realistic env vars,
   and invokes the handler against fake API Gateway events for
   `/healthz`, `/v1/me`, and `/docs`. Catches module-load failures and
   missing-bundle-asset bugs before any AWS call.
2. `cdk deploy GdpBackendDev` against the `gdp-dev` profile, with
   `--outputs-file cdk-outputs.dev.json`.
3. `scripts/smoke.ts` against the deployed `ApiUrlOutput` to verify
   end-to-end: `/healthz`, `/readyz`, auth-gating, auth verifier wiring,
   request-id propagation, `/docs`, `/openapi.yaml`.

To smoke an arbitrary deployed env without re-deploying:

```bash
npm run smoke -- https://your-api-url
```

Lower-level commands if you need them:

```bash
npm run build                     # esbuild bundle to dist/
npx cdk synth GdpBackendDev       # CloudFormation template, no AWS account needed
npx cdk deploy GdpBackendDev --profile gdp-dev
```

## Source of truth

- `openapi.yaml` — HTTP contract; mobile clients are generated from it
- `SHAPE.md` — domain model, lifecycles, DDB single-table access patterns
