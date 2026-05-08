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
npm run build
npx cdk synth
npx cdk deploy GdpBackendDev      # deploys to AWS account selected via AWS_PROFILE
```

## Source of truth

- `openapi.yaml` — HTTP contract; mobile clients are generated from it
- `SHAPE.md` — domain model, lifecycles, DDB single-table access patterns
