# Design: caching bill analysis by image

_Status: proposed (31 Oct 2026). Not built. Owner: Callum. Written for the next agent to implement._

## Problem

Reading a bill costs a Gemini call (latency 3–10 s, money per call). The same image can come in more than once:

1. **Same person, same photo again** — they backed out of the check screen, the tab died, they picked the photo from the library a second time, or they're re-splitting a receipt they already split.
2. **Someone else, same bytes** — rare (messaging apps recompress images), but free to handle.
3. **Same photo, newer parser** — we improve the prompt (e.g. parser `v2` added `course`) and old reads become stale.

And the complication: **the analysis is not the bill**. After Gemini reads the image, the lead corrects lines on _Check the bill_, and later _Fix the bill_ mid-session. Each amendment writes a new bill version. The parser's output and the bill a person is working on drift apart, and they're different things with different owners:

|                             | Analysis                                    | Bill                                         |
| --------------------------- | ------------------------------------------- | -------------------------------------------- |
| What                        | What the parser read from these exact bytes | The lead's working copy of what was ordered  |
| Changes?                    | Never                                       | Every amend makes a new version              |
| Owner                       | Nobody (a pure function of image + parser)  | The lead                                     |
| Safe to share across users? | Yes, if keyed by the exact bytes            | No — corrections, venue, session are private |

## What exists today

- `POST /v1/bills/uploads` takes the client's `sha256` and looks up `IMGHASH#<userId>#<sha256>` → `billId`. On a hit it returns `{ status: 'duplicate', billId }` and the client skips the S3 upload and goes to `/confirm-bill/<billId>`.
- `POST /v1/bills/parse` re-hashes the bytes from S3 (authoritative) and repeats the same lookup, returning `billStore.getLatest(billId)` on a hit.
- Bills are versioned: `BILL#<id>` / `V#001…` plus a `LATEST` mirror. **`V#001` is the untouched parser output** for that bill (built by `buildBillV1`), so a per-user "original analysis" already exists implicitly.
- A bill in a session holds `BILLLOCK#<billId>`. Abandon releases it; close (settled) currently does not.

Gaps:

- The cache key ignores the parser, so a bill read by `v1` is returned forever, even after `v2`.
- Nothing is reusable across users.
- A repeat returns the latest version **without context**: if that bill is already in a live session, or was settled last week, the client lands on _Check the bill_, taps _Share_, and gets a 409 "already in use".
- The analysis only lives inside a bill, so it disappears or gets muddled with amendments if the bill is forked, deleted, or amended.

## Decision

Split the two concerns.

1. **Cache the analysis, immutably, at the moment the parser returns** — before it becomes a bill and before anyone can amend it. Key it by image hash **and parser fingerprint**. This is what we reuse to avoid calling Gemini again.
2. **Never cache "what to send back".** On a repeat from the same person, _resolve_ it at request time from their own bill and its session state. Their latest amended version is the right answer for them; it's not a cache entry, it's their data.

So the answer to "at which point do we cache?" is: **right after `parser.parse()` + venue resolution, before `buildBillV1`**. What the uploader gets back is decided per request by the resolver below, and it is always their own latest bill version when they have one.

### Why not cache the amended bill?

- Amendments can be session-driven (raising a quantity because two people had one each) rather than reading corrections. They're right for that dinner, not for the image.
- Across users they'd leak one person's edits to another.
- They're already stored and versioned; caching them adds nothing.

### Why not just reuse `V#001`?

It works for the same user, but it's tied to a bill's lifecycle (its owner, its future deletion), it's not keyed by parser version, and it can't serve other users without exposing a `billId`. A separate, ownerless row is simpler to reason about.

## Data model

New item in the single table:

```
pk: ANALYSIS#<sha256>
sk: P#<parserFingerprint>          e.g. P#gemini-2.5-flash:v2:3f9a1c2e
parsed:        ParsedBillFromImage  (the validated parser output, as-is)
venue?:        Venue                (resolved Places result, if any)
analysedAt:    ISO datetime
parser, parserVersion, promptHash
ttlAt:         epoch seconds        (analysedAt + 30 days)
```

`parserFingerprint = ${model}:${version}:${promptHash}` where `promptHash` is the first 8 hex chars of `sha256(PROMPT)`. Bumping `VERSION` or editing the prompt both miss the cache, so nobody has to remember to invalidate anything. Expose it from `BillParser` as `readonly fingerprint: string`; `FixtureBillParser` returns a fixed value.

Existing `IMGHASH#<userId>#<sha256>` → `billId` stays as the per-user pointer. Add `parserFingerprint` (what read it) and `indexedAt`.

Failures are **not** cached (`PARSE_FAILED` is usually transient or config; `PARSE_LOW_CONFIDENCE` may succeed on a retry). Write with `ConditionExpression: attribute_not_exists(pk)` so two concurrent parses of the same image don't fight; the loser's result is discarded.

## Resolution flow

### `POST /v1/bills/uploads` (client-claimed hash, before upload)

```
hit = IMGHASH#<user>#<sha>
if hit:
    bill = getLatest(hit.billId)
    lock = getBillLock(bill.billId); session = lock && getSession(lock.sessionId)
    return { status: 'duplicate', billId, versionNumber, amended: versionNumber > 1,
             session?: { sessionId, status } }       # no upload needed
return { status: 'new', uploadId, url, ..., analysisCached: bool }   # optional hint
```

The client hash is only a shortcut; the server must not trust it beyond "skip an upload for this user's own bill".

### `POST /v1/bills/parse` (authoritative hash from the S3 bytes)

```
sha = sha256(bytes)
1. user hit  (IMGHASH#<user>#<sha>)  → same duplicate response as above (covers a lying/missing client hash)
2. analysis hit (ANALYSIS#<sha> / P#<current fingerprint>)
       → bill = buildBillV1(cached.parsed, cached.venue, fresh billId + itemIds,
                            parsedFrom.source = 'cache', parsedFrom.analysedAt = cached.analysedAt)
       → putVersion(bill, indexImageHash)            # no Gemini call
3. miss  → parsed = parser.parse(bytes); venue = resolve(parsed.venue)
       → put ANALYSIS row (conditional)               # ← the caching point
       → bill = buildBillV1(...); putVersion(bill, indexImageHash)
```

Step 1 deliberately wins over a newer parser: if this user already has a bill for the image, their corrections matter more than a better read. Offer a re-read only via _Start again_ (below).

The uploaded image is still needed on an analysis hit (the bill's backdrop comes from `parsedFrom.uploadId`), so a cross-user hit still uploads; it just skips Gemini. Never point one user's bill at another user's S3 object.

## What the uploader sees on a repeat

The duplicate response carries enough for the client to route:

| Their bill's state                      | Client goes to                                                         | Copy                                         |
| --------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| No session, never amended               | `/confirm-bill/<id>`                                                   | none                                         |
| No session, amended                     | `/confirm-bill/<id>`                                                   | small notice: "Picked up where you left off" |
| Session `setup` / `claiming` / `paying` | `/session/<id>` (the lead's table)                                     | none — they're back at the table             |
| Session `settled`                       | sheet: "You split this at Gennaro on Tue" → **Open** / **Start again** |                                              |
| Session `abandoned` (lock released)     | `/confirm-bill/<id>` (latest version)                                  | "Picked up where you left off"               |

**Start again** = `POST /v1/bills/{billId}/fork` with `{ from: 'latest' | 'analysis' }`:

- `latest` (default): new `billId`, version 1 copied from the latest version (their reading corrections carry over), fresh `itemId`s, `parsedFrom.forkedFrom = { billId, versionNumber }`.
- `analysis`: new bill from the current-fingerprint analysis (re-reading with today's parser if the cached row is from an older one).
- Repoint `IMGHASH#<user>#<sha>` to the new bill.

Sessions on the old bill are untouched.

## Privacy and retention

- The analysis row has no user id. It holds what's printed on the receipt: items, prices, venue. It can only be found by someone who already has the exact bytes, who therefore already has that information.
- The parser output schema has no card digits or names; keep it that way (any future field reading the payment slip must not go in the shared cache).
- 30-day TTL. Account deletion removes the user's `IMGHASH` rows and bills; analysis rows age out.
- **Open question for Callum:** global (cross-user) cache as above, or scope the analysis key by user too (`ANALYSIS#<user>#<sha>`)? Global saves money in a rare case; per-user is the zero-argument privacy story. Default in this plan: global.

## Implementation plan

Build as small PRs, each with tests.

1. **Analysis cache (API only).** `BillParser.fingerprint`; `analysisStore` (`get`, `putIfAbsent`); `parseService` steps 2–3; `parsedFrom.source: 'parser' | 'cache'` and `analysedAt` (optional fields, OpenAPI + `npm run gen:api`). Structured log events `bill.analysis.hit` / `.miss` with fingerprint. No client change.
2. **Duplicate context.** Extend `UploadDuplicate` with `versionNumber`, `amended`, `session?`. Same shape from `/parse` step 1. Client (`useUploadAndParse` + camera page) routes per the table; add the "Picked up where you left off" notice on the check sheet.
3. **Settled repeat + fork.** `POST /v1/bills/{billId}/fork`; the settled sheet on the camera page.
4. **(Optional) backfill.** One-off script seeding `ANALYSIS#` rows from existing `V#001` items where `parsedFrom.parserVersion` matches the current version. Probably not worth it; the cache warms itself.

Also worth fixing alongside (2): `close` should probably release `BILLLOCK` like `abandon` does, otherwise a settled bill blocks _Share_ forever. Check the amend rules still hold (settled bills are frozen by status, not by the lock).

## Tests

Integration (`apps/api/tests/integration/`, FixtureBillParser with a call counter):

- Same user, same image twice, untouched → same `billId`, parser called once, `amended: false`.
- Same user, after an amend → duplicate returns the latest `versionNumber` and `amended: true`; the analysis row still equals the original parse.
- Same user, bill in a claiming session → duplicate carries `session.status = 'claiming'`.
- Same user, bill abandoned → duplicate with no session; settled → `session.status = 'settled'`.
- **Different user, same bytes → new `billId`, parser not called, items equal the analysis (not the first user's amendments), fresh `itemId`s.**
- Parser fingerprint changed → miss, parser called, a second `ANALYSIS` row exists.
- Parser throws → nothing written to `ANALYSIS#`.
- Two concurrent parses of a new image → one `ANALYSIS` row, two bills (different users) or one (same user).
- Fork `latest` vs `analysis` → contents as described; `IMGHASH` repointed.

e2e (`apps/web/e2e/`, extend `FakeApi`): snap the same photo twice → back on the check sheet with the notice; snap a photo whose bill is in a live session → lands on the lead's table; settled → the sheet, _Start again_ opens a fresh check sheet.

## Non-goals

- Near-duplicate matching (a second photo of the same receipt). Different bytes, different hash. A perceptual hash could come later; it would need a confirm step ("Is this the Gennaro bill from earlier?") because false positives would merge two dinners.
- Caching failures, venue lookups separately (venue is inside the analysis row), or anything about sessions.

## Code pointers

- `apps/api/src/services/bills/uploadService.ts` — early per-user dedup
- `apps/api/src/services/bills/parseService.ts` — `parse`, `buildBillV1`
- `apps/api/src/services/bills/parser.ts`, `geminiParser.ts` (`MODEL`, `VERSION`, `PROMPT`), `fixtureParser.ts`
- `apps/api/src/storage/billStore.ts` — `putVersion`, `findByImageHash`, key helpers
- `apps/api/src/storage/sessionStore.ts` — `getBillLock`, `deleteBillLock`
- `apps/api/src/services/sessions/sessionService.ts` — `close`, `abandon`
- `packages/core/src/api/hooks/useUploadAndParse.ts`, `apps/web/app/(app)/page.tsx` — client handling of `duplicate`
- `packages/core/src/lib/image.ts` — client re-encode (max 1600 px JPEG); the hash is of these processed bytes, so the same source photo on the same browser hashes the same, but not necessarily across browsers.
