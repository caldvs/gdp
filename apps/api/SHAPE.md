# GDP Backend — Shape (v0)

> Step 1 of the rewrite brief: domain model, API surface, error codes, DDB access patterns. **No code yet.** Sign-off required before writing the OpenAPI spec.

---

## Decisions locked

| Concern               | Decision                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------- |
| Stack                 | TypeScript on Node 20+                                                                      |
| Compute               | AWS Lambda                                                                                  |
| Storage               | DynamoDB (single-table) + S3 (raw bill images)                                              |
| API                   | API Gateway HTTP API, path-versioned (`/v1/...`)                                            |
| Infra-as-code         | AWS CDK (TypeScript)                                                                        |
| Router                | Hono                                                                                        |
| Validation            | zod at every API boundary                                                                   |
| Logging               | pino, structured JSON, redacted secrets                                                     |
| Tracing               | AWS X-Ray                                                                                   |
| Auth (v0)             | Google ID tokens, server-verified via `google-auth-library`. Apple deferred.                |
| Payment provider (v0) | TrueLayer sandbox, UK Open Banking                                                          |
| Settlement model      | **Lead diner collects.** Participants pay the collector via TrueLayer. No venue onboarding. |
| Currency              | **GBP only**, **integer pence everywhere**                                                  |
| OCR                   | Gemini 2.5 Flash via `BillParser` interface (free tier: 250 req/day)                        |
| Real-time             | Polling for v0 (no WebSockets / SSE)                                                        |
| Repo                  | private, GitHub                                                                             |

---

## Domain entities

(Audit fields like `createdAt`, `updatedAt`, `version` are implicit on every entity.)

### User

- `userId` — Google `sub` claim (string, primary identity)
- `displayName`, `email`, `avatarUrl?`

### Bill (versioned)

- `billId` (UUIDv7)
- `versionNumber` (int; starts at 1, amendments increment)
- `creatorUserId`
- `currency` (always `"GBP"` in v0)
- `subtotalPence`, `taxPence`, `serviceChargePence`, `totalPence` — all `integer`
- `items[]` — array of `BillItem`
- `parsedFrom`:
  - `imageHash` (sha256 hex)
  - `parser` (e.g. `"gemini-2.5-flash"`)
  - `parserVersion`
  - `parsedAt`
- `venue?` — derived (Google Places lookup result, cached)
- `previousVersionId?` — links to prior version on amendments

### BillItem

- `itemId` (UUIDv7, **stable across amendments where item identity is preserved**)
- `name`
- `unitPricePence` (int)
- `quantity` (int)
- `category` — `"food" | "drink" | "other"`

### Session

- `sessionId` (UUIDv7)
- `joinCode` — 6 chars from a no-confusable alphabet (excludes `0`, `O`, `1`, `I`, `l`)
- `creatorUserId` — **also the `collectorUserId`** for v0
- `billId`, `pinnedBillVersion` — version pinned at session creation; amendments must be explicitly accepted into the session
- `status` — `setup | claiming | paying | settled | abandoned` (see lifecycle below)
- `participants[]` — list of `Participant` (always includes the creator)
- `ttlAt` — 30 days

**Session lifecycle:**

```
setup       creator only; claims their items; join code hidden
  │
  │  POST /v1/sessions/:id/share  (creator only; freezes creator claims;
  │                                marks creator payment as self_paid)
  ▼
claiming    join code active; others join and claim; creator claims frozen
  │
  │  POST /v1/sessions/:id/lock-claims  (creator only; computes owedPence
  │                                      for all participants; freezes claims)
  ▼
paying      payments in flight (all non-self-paid participants)
  │
  │  (automatic when all non-self-paid participants reach payment.succeeded)
  ▼
settled     terminal success

(any non-settled state) ──── POST /v1/sessions/:id/abandon ───→ abandoned
```

### Participant (composite key: `sessionId × userId`)

- `userId`
- `claimedItemIds[]`
- `owedPence` (int) — computed at `lock-claims` time, frozen
- `payment` — discriminated union:
  - `{ status: "unpaid" }`
  - `{ status: "self_paid" }` — creator only; set when session transitions `setup → claiming`
  - `{ status: "pending", paymentId }`
  - `{ status: "succeeded", paymentId, paidAt }`
  - `{ status: "failed", paymentId, reason }`

### Payment

- `paymentId` (UUIDv7)
- `sessionId`, `payerUserId`, `collectorUserId`
- `amountPence`, `currency`
- `idempotencyKey` (client-supplied UUIDv7 in `Idempotency-Key` header)
- `provider` (`"truelayer"`)
- `providerPaymentId` (TrueLayer reference)
- `status` — `pending | authorized | succeeded | failed | refunded`
- `events[]` — audit trail of state transitions, sourced from webhooks + API actions

### Venue

- `placeId` (Google Places ID, optional), `name`, `address`, `lat`, `lng`
- Cached lookup result; not authoritative.

---

## Invariants

1. **Money reconciles to the penny.** `bill.totalPence === sum(item.unitPricePence × item.quantity) + taxPence + serviceChargePence`. `sum(participant.owedPence) === bill.totalPence` exactly — rounding pennies from proportional service charge / tax allocations are deterministically assigned to one participant (largest-claimer, alphabetical-tiebreak).
2. **Items split between claimers** — when an item is claimed by N participants, its cost is divided into N integer-pence shares; the remainder pennies are allocated deterministically.
3. **Bill amendments preserve `itemId` where identity is preserved.** Renaming or repricing an item keeps its `itemId`. Splitting an item creates new IDs. Deleting an item retires the ID. **Claims attached to retired IDs are invalidated**; affected participants must re-claim before the session can advance to `paying`.
4. **All items must be claimed by ≥1 participant** before `claiming → paying` is allowed.
5. **Session status is monotonic** (no backwards transitions): `setup → claiming → paying → settled`. `abandoned` can be entered from any non-`settled` state.
   - `setup → claiming` triggered by `POST /share`; creator's claims are frozen and creator's `payment.status` is set to `self_paid`. Once shared, the creator cannot modify their own claims.
   - In `setup`, the join code is not returned to anyone (including the creator); it becomes visible only after `share`.
6. **Idempotency keys are unique per `(userId, endpoint, key)` tuple**, cached for 24h. Same key with different body → 409 `IDEMPOTENCY_CONFLICT`. Same key with same body → cached response.
7. **Auth is non-bypassable.** Every endpoint except `/healthz`, `/readyz`, OAuth callbacks, and `/webhooks/*` requires a verified Google ID token. The `userId` in any request body is ignored — only the verified token's `sub` claim is trusted.

---

## API surface (v1)

### Identity

- `GET /v1/me` — return the verified user

### Bills

- `POST /v1/bills/uploads` — request pre-signed S3 PUT URL; short-circuits on hash hit returning `{ status: "duplicate", billId }`
- `POST /v1/bills/parse` — parse uploaded image; synchronous, idempotent via `Idempotency-Key`
- `GET /v1/bills/:id` — get bill, optional `?version=N` (defaults to latest)
- `POST /v1/bills/:id/amend` — user edits; creates a new version; returns the new version. Allowed only when the bill is either (a) not yet attached to any session, or (b) attached to a session in `setup` or `claiming`. Once a session locks claims and enters `paying`, the bill is frozen.

### Sessions

- `POST /v1/sessions` — create session from a bill; status starts at `setup`; creator becomes collector
- `GET /v1/sessions/:id` — full session state including participants (join code hidden in `setup` for non-creators)
- `POST /v1/sessions/:id/share` — creator transitions `setup → claiming`; freezes creator's claims; marks creator's `payment.status = "self_paid"`; activates join code
- `POST /v1/sessions/by-code` — resolve a 6-char join code → returns `{ sessionId }` (only works when session is `claiming`)
- `POST /v1/sessions/:id/join` — current user joins
- `POST /v1/sessions/:id/claims` — replace current user's claim list (full list per call, not delta). Creator can call in `setup`; others can call in `claiming`.
- `POST /v1/sessions/:id/lock-claims` — creator transitions `claiming → paying`; computes `owedPence` per participant; freezes
- `POST /v1/sessions/:id/abandon` — creator only

### Payments

- `POST /v1/sessions/:id/payments` — current user initiates payment to the collector (idempotent via header)
- `GET /v1/payments/:id` — get payment state

### Webhooks

- `POST /webhooks/truelayer` — TrueLayer payment-status events; signature-verified, no auth header required

### Ops

- `GET /healthz` — liveness; no auth
- `GET /readyz` — DDB + S3 connectivity check; no auth

---

## Error envelope

```json
{
  "error": {
    "code": "BILL_NOT_FOUND",
    "message": "Human-safe message",
    "requestId": "req_01J...",
    "details": {/* optional, omitted in prod */}
  }
}
```

### Initial error code set

| Code                     | HTTP | When                                                         |
| ------------------------ | ---- | ------------------------------------------------------------ |
| `AUTH_MISSING`           | 401  | No `Authorization` header                                    |
| `AUTH_INVALID`           | 401  | Token signature/audience invalid                             |
| `AUTH_EXPIRED`           | 401  | Token expired                                                |
| `INVALID_INPUT`          | 400  | zod validation failed (`details` carries field-level errors) |
| `IDEMPOTENCY_CONFLICT`   | 409  | Same key, different body                                     |
| `NOT_FOUND`              | 404  | Generic                                                      |
| `BILL_NOT_FOUND`         | 404  |                                                              |
| `SESSION_NOT_FOUND`      | 404  |                                                              |
| `PAYMENT_NOT_FOUND`      | 404  |                                                              |
| `SESSION_INVALID_STATE`  | 409  | e.g., claim on a `paying` session                            |
| `CLAIMS_INCOMPLETE`      | 409  | `lock-claims` with unclaimed items                           |
| `PARSE_FAILED`           | 422  | Gemini returned but zod rejected output                      |
| `PARSE_LOW_CONFIDENCE`   | 422  | Parsed but below threshold                                   |
| `RATE_LIMITED`           | 429  | API GW or app-level limit hit                                |
| `PAYMENT_PROVIDER_ERROR` | 502  | TrueLayer 5xx / unreachable                                  |
| `INTERNAL_ERROR`         | 500  | Catch-all                                                    |

---

## DynamoDB single-table design

One table per env: `gdp-{env}` (e.g. `gdp-dev`, `gdp-prod`).

| Entity                | PK                         | SK                     | Purpose                                     |
| --------------------- | -------------------------- | ---------------------- | ------------------------------------------- |
| User                  | `USER#{userId}`            | `USER#{userId}`        | profile                                     |
| Bill (version)        | `BILL#{billId}`            | `V#{nnn}`              | each version (zero-padded for sort)         |
| Bill (latest pointer) | `BILL#{billId}`            | `LATEST`               | mirror of current version for one-shot read |
| Session metadata      | `SESS#{sessionId}`         | `META`                 | session core                                |
| Participant           | `SESS#{sessionId}`         | `PART#{userId}`        | per-participant record                      |
| Payment               | `PAY#{paymentId}`          | `PAY#{paymentId}`      | payment record                              |
| Idempotency cache     | `IDMP#{userId}#{endpoint}` | `KEY#{idempotencyKey}` | 24h TTL                                     |
| Image hash index      | `IMGHASH#{sha256}`         | `IMGHASH#{sha256}`     | dedupe lookup                               |
| Join code index       | `JCODE#{code}`             | `JCODE#{code}`         | code → sessionId; 30d TTL                   |

### Global secondary indexes

- **GSI1 — `byUser`** (sparse): `GSI1PK = USER#{userId}`, `GSI1SK = {SESS|PAY}#{id}`. Lists a user's sessions and payments.
- **GSI2 — `byProviderPaymentId`**: `GSI2PK = PROVPAY#{providerPaymentId}`. Webhook handler resolves TrueLayer's reference back to our `paymentId` in O(1).

### Access patterns covered

| #   | Pattern                        | Lookup                         |
| --- | ------------------------------ | ------------------------------ |
| 1   | Get user                       | PK `USER#{u}`                  |
| 2   | Get bill (latest)              | PK `BILL#{b}` SK `LATEST`      |
| 3   | Get bill v3                    | PK `BILL#{b}` SK `V#003`       |
| 4   | Get session + all participants | PK `SESS#{s}` query            |
| 5   | List user's sessions           | GSI1 query on `USER#{u}`       |
| 6   | Resolve join code              | PK `JCODE#{c}`                 |
| 7   | Resolve image hash → billId    | PK `IMGHASH#{h}`               |
| 8   | Idempotency check              | PK `IDMP#{u}#{e}` SK `KEY#{k}` |
| 9   | Webhook → our paymentId        | GSI2 on `PROVPAY#{x}`          |
| 10  | Get payment                    | PK `PAY#{p}`                   |

TTL attribute on every ephemeral row (`idempotency`, `joinCode`, `session`).

---

## Out of scope for v0

- Apple sign-in
- Multi-currency / FX
- WebSockets / SSE / push (polling only)
- Venue onboarding / direct-to-venue payments
- User-facing audit log / GDPR self-service deletion (support-handled for v0)
- Receipts / email confirmation
- Loyalty / referral / discount codes

---

## Decisions captured

- Repo: `caldvs/gdp-backend` (private)
- AWS region: `eu-west-2` (London) — deployment deferred until AWS account exists; develop locally first
- Self-pay model: creator claims their items in `setup`, hits "share with table" to expose the join code; their claims freeze and `payment.status = "self_paid"` (they paid the venue with their card)
- Bill amendment lifecycle: allowed during `setup` and `claiming`; frozen at `paying`

## Status

**Shape v1 — pending sign-off.** Once approved, the next checkpoint is the OpenAPI spec.
