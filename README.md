# paymeback.dev

Snap the bill, share a QR, claim what you had, pay the lead direct. Guests don't install anything.

A web app (mobile-first) and its API, in one npm workspaces repo.

```
apps/web       Next.js 16 web app
apps/api       API: Hono on AWS Lambda, DynamoDB, S3, deployed with CDK
packages/core  Shared client code: typed API client, React Query hooks, money / QR / payout helpers
docs/          Architecture diagrams, decisions, deploy guide, designs
```

## How it works

1. The **lead** photographs the bill. The API reads it (Claude Sonnet on Amazon Bedrock), looks up the restaurant's address (Amazon Location Service), and the lead checks the items.
2. The lead enters their bank details, pays the **table fee** (£2, or £3 over £100, via Stripe; skipped when Stripe isn't configured), and gets a QR code and join code. The bank details stay in their browser and travel to guests in the link's `#p=` fragment ([ADR-0002](docs/decisions.md#adr-0002-bank-details-stay-on-the-leads-device)).
3. **Guests** join, tick what they had or split shared items ([ADR-0006](docs/decisions.md#adr-0006-splits-by-ways)), and see their share including service.
4. Guests pay the lead by bank transfer (tap-to-copy details, Monzo/Revolut links) and tap _I've paid_. The app never holds money.
5. The **lead** confirms payments, takes any leftover items, and closes the bill. Only the lead can close it. Closing emails every diner their bill report.

See [docs/architecture](docs/architecture/README.md) for the system and data model diagrams.

## Getting started

Node 22 (`nvm use`) and Docker.

```bash
npm install
npm run dev:local      # API on :3000 (with DynamoDB Local + MinIO) and web on :8081
```

Bill reading uses Bedrock even locally: set `BEDROCK_MODEL_ID` and `AWS_PROFILE=gdp-dev` in `apps/api/.env.local` (see `apps/api/.env.example`). Locally you sign in with just an email: the same email is always the same account.

`npm run dev` runs only the web app, against the deployed dev API.

## Commands

| Command                                    |                                                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev:local`                        | API + web (web pointed at the local API) + Stripe webhook forwarding, so the table fee completes locally. Needs the [Stripe CLI](https://stripe.com/docs/stripe-cli) logged in; without it, payments are off and everything else still runs. `DEV_NO_STRIPE=1` skips the forwarder. |
| `npm run dev` / `npm run dev:api`          | Web only / API only                                                                                                                                                                                                                                                                 |
| `npm run typecheck`                        | All workspaces (the pre-commit hook runs it)                                                                                                                                                                                                                                        |
| `npm test`                                 | Unit tests (`packages/core`, `apps/api`)                                                                                                                                                                                                                                            |
| `npm run test:int -w apps/api`             | Integration tests (needs `npm run ddb:up -w apps/api`)                                                                                                                                                                                                                              |
| `npm run build && npm run e2e -w apps/web` | Playwright e2e against an in-memory fake API                                                                                                                                                                                                                                        |
| `npm run gen:api`                          | Regenerate client types from `apps/api/openapi.yaml`                                                                                                                                                                                                                                |
| `npm run deploy:dev -w apps/api`           | Deploy the dev API stack and smoke-test it                                                                                                                                                                                                                                          |

An API contract change and the matching client change go in the same commit, since the client types come from `openapi.yaml`.

## Docs

- [docs/architecture](docs/architecture/README.md): system and data model diagrams
- [docs/decisions.md](docs/decisions.md): product and technical decisions
- [docs/deploy.md](docs/deploy.md): deploying the API (CDK) and web (Vercel)
- [docs/email.md](docs/email.md): email through Amazon SES: the paymeback.dev sending domain, leaving the sandbox
- [docs/table-fee.md](docs/table-fee.md): the Stripe table fee and what's left before it takes real money
- [docs/design](docs/design): designs not yet built
- [apps/api/README.md](apps/api/README.md) and [apps/api/RUNBOOK.md](apps/api/RUNBOOK.md): the API and what to do when an alarm fires
- [apps/web/README.md](apps/web/README.md): the web app and its tests
- [HANDOVER.md](HANDOVER.md): where the work is right now
