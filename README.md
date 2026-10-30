# Group Dine Pay

Snap the bill, share a QR, claim what you had, pay the lead direct. Your friends don't install anything.

This is the monorepo for the web app and its API.

```
apps/
  web/     Next.js web app (the client — replaces the Expo app)
  api/     Backend: Hono on AWS Lambda + DynamoDB + S3, deployed with CDK (was caldvs/gdp-backend)
packages/
  core/    Shared client code: typed API client, React Query hooks, money / QR / payout helpers
```

`apps/api` was imported from `gdp-backend` with its full git history. `packages/core` was extracted
from `gdp-mobile` — the parts that weren't tied to React Native — along with their tests. The web
app's styling is the Calm design system's own CSS (`tokens.css` + `components.css` from the design
hand-off), so it matches the mobile app's look.

## Getting started

Requires Node 22 (`nvm use`). Install once, from the repo root:

```bash
npm install
npm run dev            # web app on http://localhost:8081, talking to the deployed dev API
```

To run everything locally (needs Docker running):

```bash
npm run dev:api                                                # terminal 1: API on :3000
echo 'NEXT_PUBLIC_API_BASE_URL=http://localhost:3000' > apps/web/.env.local
npm run dev                                                    # terminal 2: web on :8081
```

Locally, sign-in skips the emailed code: type any email and you're in. The same email always gets
the same account (with its bills and sessions); a new email is a new user. The web app remembers the
last email and signs you straight back in; *Sign out* in the menu lets you switch accounts, and the
alice / bob / charlie / diana buttons are one-tap test accounts. The local DynamoDB and S3 data are
kept in Docker volumes between restarts (`docker compose down -v` in `apps/api` wipes them).

`npm run dev:api` reads `apps/api/.env` and `apps/api/.env.local` (put `GEMINI_API_KEY` there so
bill scanning works). Dev sign-in only exists on the local server — never in the Lambda — and can be
turned off with `AUTH_DEV_EMAIL_SIGNIN=false`. Other web settings are listed in `apps/web/.env.example`.

## Common commands

| Command | |
| --- | --- |
| `npm run dev` | Web app (Next.js) on :8081 |
| `npm run dev:api` | API locally on :3000 |
| `npm run build` | Production build of the web app |
| `npm run typecheck` | All workspaces |
| `npm test` | Unit tests: `packages/core` + `apps/api` |
| `npm run gen:api` | Regenerate `packages/core/src/api/schema.d.ts` from `apps/api/openapi.yaml` |
| `npm run e2e -w apps/web` | Playwright smoke tests (needs `npm run build` first) |
| `npm run deploy:dev -w apps/api` | Validate the Lambda bundle, deploy the dev stack, smoke-test it |

Because the client types are generated from the API's own `openapi.yaml`, an API contract change
and the matching web change land in the same commit.

## How the app works

1. **Lead** signs in (email code), photographs the bill, checks the parsed items, then opens a session.
2. Their **bank details** stay in their browser tab (ADR-0002) and travel to diners inside the join
   QR's `#p=` fragment, which is never sent to a server.
3. **Diners** scan the QR (or type the 6-character code), sign in, tap the items they had, split
   shareable things like a bottle of wine, and tap *I'm done*.
4. Each diner sees exactly what to transfer and marks it sent; the lead taps *mark received* as the
   money lands. When everyone's received, the session is settled.

## Deploying

- **API** — GitHub Actions (`.github/workflows/api-deploy.yml`) deploys the dev stack on push to `main`,
  using an OIDC role. If this repo isn't `caldvs/gdp-backend`, update that role's trust policy to the
  new repo name first.
- **Web** — any host that runs Next.js (Vercel, Netlify, Amplify, a Node server). Set
  `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_PUBLIC_BASE_URL` (the site's own URL, used in QR codes).
