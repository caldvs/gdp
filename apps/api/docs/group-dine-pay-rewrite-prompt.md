# Group Dine Pay — Backend Rewrite Brief

You are starting a greenfield TypeScript backend for Group Dine Pay. The product is a group bill-splitting app for restaurant diners. There's a prior implementation; treat it as **reference for the domain, not template for the code**.

This brief is **backend-only**. The mobile app is its own project, sequenced after the backend is solid. Your job is to build a backend a future mobile team would actually want to integrate against — clean contract, real auth, observable, testable, deployable.

---

## Read this in full before writing any code

Skim every section. Then read the existing-code references for domain understanding. Then _stop and ask the user the open questions at the bottom_ before writing anything.

---

## What the product is

A group bill-splitting app. One person at the table photographs a paper bill. The backend uses an LLM with vision (Gemini, Claude, or successor) to parse line items. Other diners join the session via a short code or QR. Each diner claims their items. The backend calculates each person's share including proportional service charge, tax, and tip — in pence — and orchestrates payment via Open Banking (TrueLayer or similar).

Mobile-first product. The backend is a public-internet HTTP API serving a mobile client.

---

## Architecture decisions already made — do not re-debate

- **Standalone repo** for the backend (polyrepo with the future mobile repo). New repo: `group-dine-pay-api`.
- **TypeScript on Node 20+.** Single language, no transpile surprises.
- **AWS Lambda + DynamoDB**, deployed by **AWS CDK** (TypeScript). One deployable per environment (dev / staging / prod). DynamoDB single-table design with computed PK/SK — discuss the access patterns before locking the key schema.
- **API Gateway HTTP API** (not REST API; cheaper, simpler, sufficient).
- **OpenAPI 3.1 spec is the source of truth for the API contract.** Generated from zod schemas with `zod-openapi` or hand-written and validated against the implementation — pick one and stick to it. The spec is committed in the repo at `openapi.yaml` and published to the mobile team via a release artifact.
- **Path-based API versioning from day one** — `/v1/...`. You will need to support multiple versions in parallel within 12 months once the mobile client is in the App Store.
- **Money is integer pence.** Never floats. Storage, wire format, calculation. Display formatting is the client's job.
- **All input validated with zod at the boundary.** Generated TypeScript types come _from_ the zod schemas, not the other way around.
- **Real auth.** Google sign-in via server-verified ID tokens (`google-auth-library`). The server never trusts a `userId` from a request. The verified `sub` claim is the only source of caller identity.
- **Idempotency keys required on every state-changing payment endpoint.** Standard `Idempotency-Key` header, stored in DynamoDB with a TTL, returns the cached response on retry.
- **Webhook signatures verified, not stubbed.** If a provider's signature can't be verified, return 401 and log it.
- **Logs redact secrets.** Use a redaction allowlist, not a blocklist.

---

## What "really solid" means here

The bar isn't "it works in dev". The bar is "an on-call engineer who didn't write this can debug a 2am incident with the logs and metrics you produced". Concretely:

### Observability is part of v0, not a later chore

- **Structured logs** (pino) with a stable schema. Every log line has `requestId`, `userId` (when authed), `route`, `latencyMs`. JSON to stdout, ingested by CloudWatch.
- **Request IDs propagated** through every layer; returned to the client as `X-Request-Id` so support tickets can be cross-referenced.
- **Metrics** for the four golden signals — request count, error rate, latency p50/p95/p99, saturation (concurrent executions). CloudWatch metric filters or EMF.
- **Distributed tracing** with AWS X-Ray. One trace per request. Span every external call (DynamoDB, Gemini, TrueLayer).
- **Health endpoint** at `GET /healthz` (liveness) and `GET /readyz` (DDB connectivity check). No auth.

### Errors are typed and documented

- One error envelope: `{ error: { code: "BILL_NOT_FOUND", message: "...", requestId: "...", details?: {...} } }`. Codes are SCREAMING_SNAKE_CASE, namespaced where useful, and listed in the OpenAPI spec.
- Don't leak internal error messages. The `message` field is safe to show users; `details` is for debugging and is omitted in prod.
- HTTP statuses follow RFC 7231 honestly — 404 means not found, not "anything that went wrong with that resource".

### Tests run against real infrastructure where it matters

- **DynamoDB Local in Docker** for integration tests. Not mocks. The prior codebase's mocked tests would have hidden float-money bugs and key-schema mistakes; you don't get to repeat that.
- **Test pyramid**:
  - Unit tests for the non-trivial pure logic — proportional split arithmetic, currency formatting, idempotency-key cache logic, signature verification. Fast, plentiful.
  - Integration tests for every handler — real DDB, real validation, real auth (with a test JWT signer). One test per documented behaviour, including the unhappy paths in the OpenAPI spec.
  - One end-to-end smoke test per critical flow against a deployed dev environment, run on every deploy.
- **No test that asserts "the handler called the service".** If a test only verifies the implementation, delete it.
- **CI runs lint, type-check, unit, integration, build, audit (npm audit / socket.dev), and OpenAPI lint** on every PR.

### Deployment is reproducible and reversible

- **CDK stacks** are the only way infra changes get to AWS. No console clicks. The dev environment is created from the same code as prod.
- **Per-environment config** comes from AWS SSM Parameter Store and Secrets Manager, not `.env` files. Local dev uses a `.env` for convenience but the loader is identical.
- **Rollback is `cdk deploy` of the previous git commit.** No special procedure.
- **Cold-start budget** — keep the deployed bundle small (esbuild, tree-shake, no AWS SDK v2). Aim for <500ms cold start on a 1024MB Lambda. Measure it; don't guess.

### Operations

- **Rate limiting** via API Gateway usage plans for v0. Per-IP for unauthed routes, per-user for authed. Numbers are reviewable in code, not magic in the console.
- **Throttle DynamoDB** with on-demand mode initially. Re-evaluate at 1k req/s sustained.
- **TTLs everywhere** that data is ephemeral — sessions (30d), idempotency cache (24h), magic links if any (15m). DDB TTL attribute, indexed.
- **Backups** — point-in-time recovery enabled on every prod table from day one.

---

## Anti-patterns to avoid (all present in the previous attempt)

1. **Floating-point money.** Use integer pence. End of discussion.
2. **Trust-the-client auth.** No reading `userId` / `googleId` from request bodies.
3. **Commented-out security.** No `// verifySignature(...)` lines. Either it works or the endpoint returns 401.
4. **God-handlers.** No 600-line `lambda.ts` with router-plus-business-logic. Use Hono (recommended) or AWS Lambda Powertools router. Keep handlers under ~80 lines.
5. **Optional grab-bag fields.** If a field is required for the domain, type it as required.
6. **Booleans where state machines belong.** `hasPaid: boolean` becomes `payment: { status: 'pending' | 'authorized' | 'succeeded' | 'failed' | 'refunded', ... }`. Discriminated union.
7. **Embedded copies of mutable data.** The prior session document embedded the bill; amendments left sessions stale. Reference by id; if you must denormalize for read performance, version the embedded copy and reconcile on read.
8. **CORS that defaults to `*`.** Allowlist must deny by default.
9. **Mocked tests for things that fail in production.** DDB key schema, Gemini response shape, TrueLayer signatures — these need real or realistic test doubles.
10. **README/SUMMARY documentation that drifts.** The OpenAPI spec is the only API documentation. The README explains how to run the project, nothing else.

---

## The existing code: what to read, what to ignore

Existing repo: `caldvs/group-dine-pay`, locally at `/Users/callum/software-local/group-dine-pay`. Reference, not template. **Do not copy code.**

### Worth reading for domain knowledge

- `packages/backend/src/services/geminiVisionParser.ts` lines ~68-100 — **the prompt is the most domain-mature thing in the project**. It handles hierarchical items, kitchen notes, ambiguous prices. Steal the prompt design. Rewrite the surrounding code.
- `packages/backend/src/services/venueVerification.ts` — graceful-degradation pattern for Google Places lookup is reasonable. Keep the pattern, not the code.
- `packages/backend/src/types/billSplitting.ts` — entity shapes (Bill, BillItem, Participant, BillSplitSession) as a starting point for your domain modelling. Read with the anti-patterns list in hand.
- `packages/backend/src/handlers/truelayerHandler.ts` and `paymentInitiationHandler.ts` — for the rough shape of the TrueLayer integration only. Note carefully what's _missing_ (signature verification, idempotency).

### Ignore entirely

- `lambda.ts` (router shape is wrong)
- All Kotlin code (`*.kt`, `build.gradle.kts`)
- The 12 `KOTLIN-*.md` and `*-SUMMARY.md` files (stale rewrite breadcrumbs)
- Any test file in the prior codebase

---

## Bill parsing & image pipeline (v0 spec — implement this, don't re-derive)

### Flow

```
On-device (Expo)
  1. Camera capture
  2. expo-image-manipulator: resize to 1600px max edge, JPEG q=80
     (typical 8MB raw → ~300KB; saves ~95% bandwidth)
  3. SHA-256 of the resized bytes
  4. Generate idempotencyKey (UUIDv7)
        │
        │ POST /v1/bills/uploads  { sha256, sizeBytes, mimeType }
        ▼
API Lambda
  • Look up sha256 in BillImageIndex (DDB)
      hit  → { status: "duplicate", billId }      ← short-circuit, no Gemini call
      miss → mint uploadId, return pre-signed S3 PUT URL
        │
        │ PUT (binary) directly to pre-signed URL — bypasses API Gateway
        ▼
  S3: gdp-bills-raw-{env}/{userId}/{uploadId}.jpg
        │
        │ POST /v1/bills/parse  { uploadId, idempotencyKey }
        ▼
Parse Lambda  (1024MB, 25s timeout)
  1. Idempotency cache lookup → hit returns cached response
  2. Fetch image from S3
  3. Validate: real JPEG, dimensions sane, size ≤ 5MB
  4. BillParser.parse(image) — Gemini 2.5 Flash for v0
  5. Validate parser output with zod (LLMs return malformed JSON ~1%)
  6. Persist Bill v1 in DDB; index sha256 → billId
  7. Cache idempotencyKey → response (24h TTL)
  8. Return { billId, bill, parser, modelVersion, confidence }
```

### Key decisions

- **`BillParser` interface, not a hardcoded Gemini call.** v0 ships `GeminiBillParser`. Adding `GroqBillParser` or `TextractBillParser` later must be a config change, not a refactor. The Bill record stores `parser` and `modelVersion` for audit and so cached parses can be invalidated when the model is upgraded.
- **Session-scoped uploads — only the session creator uploads.** Other diners join the session and fetch the already-parsed bill; they never see a camera screen. This is what makes "Gemini calls/day ≈ unique parsed bills/day" actually hold. Image-hash dedupe only catches same-bytes retries from the same phone (small case) — different phones photographing the same bill produce different hashes.
- **Two dedupe layers, different purposes:**
  - **Idempotency key** (client UUIDv7, `Idempotency-Key` header) — catches retries by the same user. 24h TTL.
  - **Image hash** (SHA-256 of resized bytes) — catches same-bytes re-uploads, becomes part of `parsedFrom` provenance. Lives forever.
- **Validate parser output with zod, do NOT auto-retry on validation failure.** Surface "couldn't read your bill, want to retake?" to the user. Auto-retry would double-bill Gemini on transient model hiccups and hide quality issues.
- **Confirm-bill screen before commit (mobile concern, but shapes the API).** User reviews and edits obvious parse errors before the bill is locked into a session. The `POST /v1/bills/:id/amend` endpoint backs this and creates a new version. Significantly cuts re-parse rate.
- **Synchronous parse for v0.** Gemini Flash is typically 3–8s, well under the 25s Lambda / 30s API Gateway HTTP API limits. If you ever measure latency drifting past 20s, swap to async with a `202 Accepted { jobId }` response and a poll endpoint — clients won't notice.

### Endpoints (subset of v1)

- `POST /v1/bills/uploads` — request pre-signed S3 PUT URL. Returns `{ uploadId, url, expiresAt }` or `{ status: "duplicate", billId }` if the sha256 is already known.
- `POST /v1/bills/parse` — body `{ uploadId, idempotencyKey }`. Synchronous. Returns the parsed bill.
- `GET /v1/bills/:id` — retrieve a bill by id (versioned; defaults to latest version).
- `POST /v1/bills/:id/amend` — user-edited corrections, creates a new bill version.

### S3 bucket spec

- Single bucket per env: `gdp-bills-raw-{env}`.
- SSE-S3 encryption, all public access blocked.
- Pre-signed URL is scoped: PUT only, specific key, `Content-Length` range capped at 5MB, 5-minute expiry.
- Object key: `{userId}/{uploadId}.jpg` (userId from verified token; uploadId is a server-minted UUIDv7).
- Lifecycle: transition to Glacier Instant after 30 days, delete after 365. PII consideration — bills contain personal data.

### Cost & quota model

- Gemini 2.5 Flash free tier: **250 req/day, 10 RPM**, vision included.
- With session-scoped uploads + dedupe, daily Gemini calls ≈ daily unique parsed bills.
- Headroom: 250 bills/day × ~4 diners/bill ≈ 30k user-sessions/month. v0 fits comfortably.
- Future levers if quota becomes a problem (do **not** build for v0): fallback chain to Gemini 2.5 Flash-Lite (separate 1k req/day bucket) or Groq Llama 3.2 11B Vision (1k req/day, OpenAI-compatible API, prompt translates almost unchanged).

---

## Domain you need to model

Write the domain in plain English with the user before any code. Starting points, with corrections you should propose:

- **Bill** — line items, subtotal, tax, service charge, total, currency. Items have id, name, unit price (pence), quantity. Has `parsedFrom` provenance (image hash, parser response id, model version) for audit. **Versioned** — amendments produce a new version, not in-place edits.
- **Session** — references bill by id (don't embed; if you do, version it). Short join code (avoid ambiguous chars: no 0/O/1/I/l). Lifecycle: `open → claiming → paying → settled | abandoned`. Owner is the diner who created it. TTL.
- **Participant** — user × session. Tracks claimed item ids. Has `owedPence`. Has payment status (discriminated union). Invariant: across all participants, each item id is claimed by at least one participant before the session can move from `claiming` to `paying`.
- **Payment** — first-class entity, not a flag. Has `provider`, `providerPaymentId`, `idempotencyKey`, `amountPence`, `status`. Lifecycle: `pending → authorized → succeeded | failed | refunded`. Webhook events update the state machine.
- **User** — Google `sub` claim is the primary key. Display name, avatar, email. Server-managed.
- **Venue** — derived from bill + Google Places lookup. Cached. Optional on the bill but resolved when possible.

For each entity, write the invariants down explicitly and encode them as zod refinements where the type system can carry them (e.g. `claimedItemIds.length > 0 implies status !== 'open'`).

---

## How to sequence the work

**Do not bulk-generate the project.** Stop at every checkpoint, show the user, and only proceed when they confirm.

1. **Shape (no code).** Domain model, API surface, error codes, key access patterns for the single-table DDB design. ~1 page. Sign-off required.
2. **OpenAPI spec.** `openapi.yaml` for v1: endpoints, schemas, error responses, security schemes. Sign-off required — this is the contract that's expensive to change.
3. **Repo skeleton.** `package.json`, `tsconfig`, eslint, prettier, vitest, esbuild, husky pre-commit (lint + type-check on staged), CI workflow (`.github/workflows/ci.yml`), CDK stack scaffolding, Docker Compose for DDB Local, `README.md` (run/test/deploy only). Push. Sign-off.
4. **Foundations layer** before any domain endpoints:
   - Hono router on Lambda
   - Auth middleware (Google ID token verification, request context with verified `userId`)
   - Zod validation middleware
   - Error envelope + error class hierarchy
   - Pino logging with request ID, redaction allowlist
   - X-Ray tracing wired
   - `GET /healthz` and `GET /readyz`
   - Idempotency middleware (looks up `Idempotency-Key`, caches in DDB)
   - One trivial authed endpoint (`GET /v1/me`) end-to-end with integration tests against DDB Local
   - CDK deploys this to dev. Smoke test passes.
   - **This is the moment to slow down.** The foundations layer is the highest-leverage code in the project. Get it right before adding domain logic.
5. **Bills.** Implement the image pipeline spec'd in the "Bill parsing & image pipeline (v0 spec)" section above — `BillParser` interface, S3 pre-signed PUT, two-step uploads/parse, hash + idempotency dedupe, session-scoped uploads. Bill versioning lands here. Real Gemini calls in dev, deterministic fixture in tests.
6. **Sessions.** `POST /v1/sessions`, `GET /v1/sessions/:id`, `POST /v1/sessions/:id/join`, `POST /v1/sessions/:id/claim`, state machine transitions, the proportional-split arithmetic. The arithmetic gets a rich unit test suite — every rounding edge case, totals reconcile to the penny.
7. **Payments.** TrueLayer integration with idempotency keys, webhook signature verification, payment state machine, webhook handler. **This is the highest-risk surface — slowest to build, most tests, most observability.**
8. **Hardening.** Rate limit tuning, alarms (CloudWatch alarms on error rate and p99 latency), runbook for the most likely incidents, load test on dev (artillery or k6), cost review.

If the user asks you to skip ahead, push back: "We haven't sorted X yet, and skipping it tends to cause Y."

---

## What "Backend v0 done" means

- Repo deployed to a dev environment via CDK.
- Auth works: a real Google ID token can hit `GET /v1/me` and the server can't be tricked by spoofing the `sub` in the request body.
- A user can: parse a bill, create a session, share the join code, have a second user join and claim items, see the calculated split, initiate a (sandbox) TrueLayer payment, receive and verify the webhook, see the payment marked succeeded.
- Money is integer pence end-to-end.
- All endpoints are zod-validated and behind real auth (except `/healthz`, `/readyz`, the OAuth callback, and the webhook).
- OpenAPI spec matches the implementation; CI fails if it doesn't.
- Idempotency on payment endpoints is real and tested with a duplicate-request integration test.
- Webhook signature verification is real and tested with a forged-signature integration test.
- Logs are structured, redacted, and have request IDs.
- X-Ray traces show the full request path.
- Integration tests run on every PR; deploys are blocked if they fail.
- CDK deploys the whole thing from a clean machine in <10 minutes.
- A short runbook exists for: "API is returning 5xx", "payments stuck in pending", "DDB throttling".

If you're tempted to skip an item from this list, that's the moment to stop and ask.

---

## Open questions to ask the user before you start

Don't pick these for them.

1. **Auth providers.** Google only for v0, or also Apple sign-in (App Store sometimes requires Apple if you ship social login)?
2. **Payment provider.** TrueLayer was used previously. Confirm? Region (UK / EU / US) shapes this hard. Sandbox creds available?
3. **Currency scope.** GBP-only for v0, or multi-currency? Multi-currency adds significant complexity to the bill model.
4. **OCR provider.** Gemini Vision was used. Confirm? Claude or OpenAI vision are both viable; the prompt port is straightforward.
5. **Hosting confirmed?** AWS Lambda + DynamoDB. If cost or cold-start is a concern, Cloudflare Workers + D1 or Fly + Postgres are reasonable alternatives — but the rest of this brief assumes AWS.
6. **AWS account access.** Do you already have an account / an existing AWS profile? Should this share infrastructure with anything else?
7. **Public or private repo?**
8. **One-paying-collector vs each-pays-venue.** This is a UX call with major impact on the payment model — does one diner collect from the others and pay, or does each diner pay the venue directly via Open Banking? Affects the Payment entity and the TrueLayer flow.
9. **Real-time updates.** When a participant joins or claims an item, do other participants see it live (polling / SSE / WebSockets) or on refresh? Default to polling for v0 unless otherwise stated.
10. **Compliance scope.** Any PCI/PSD2/GDPR considerations the user wants in scope from day one (data retention policy, right-to-delete, audit log)?

Get answers to 1, 2, 3, 5, 6, 8 before writing the OpenAPI spec. The rest can follow.

---

## Working style expectations

- Be opinionated. If the user is wrong about something, say so once with the reason, then defer if they push back.
- No code comments that narrate what the code does. Names should suffice. Comments are for non-obvious _why_.
- Don't write README files beyond run/test/deploy. Don't generate `*-SUMMARY.md` files. The OpenAPI spec is the API documentation.
- Don't add abstractions for hypothetical future needs. Three similar lines is better than a premature abstraction.
- Don't catch errors you can't handle. Let them propagate to the error envelope middleware. Internal calls don't need try/catch.
- One PR per checkpoint above. Small, reviewable, mergeable. Not one giant "v0" PR.
- When you finish a checkpoint, summarise in two sentences what landed and what's next. No more.

---

## When you finish reading this

Reply with:

1. A one-paragraph statement of what you understand the product and the backend's responsibilities to be (in your own words).
2. Anything in this brief that seems wrong, contradictory, or missing.
3. The numbered open questions above, asked of the user.

Then wait for answers. Don't start the rewrite until step 1 (Shape) is signed off.
