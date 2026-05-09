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
npm run deploy:dev                # cdk deploy GdpBackendDev (eu-west-2) + post-deploy smoke
```

`deploy:dev` runs `cdk deploy` against the `gdp-dev` AWS profile, writes
the stack outputs to `cdk-outputs.dev.json`, then runs `scripts/smoke.ts`
against the deployed `ApiUrlOutput` to verify `/healthz`, `/readyz`,
auth-gating, and request-id propagation.

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
