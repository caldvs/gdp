# Handover

_Where the work is right now. Rewrite this when you finish something; don't append history._

_Last updated 1 Nov 2026._

## State of main

- **The app** is the Option D web UI. The whole flow is built: scan → check the bill → bank details → table fee (when Stripe is configured) → QR → guests claim and split → pay the lead → lead closes → everyone's emailed a report. See the [README](README.md) and [decisions](docs/decisions.md).
- **Bill reading** is Claude Haiku 4.5 on Bedrock, with Gemini as the fallback.
- **The dev API deploys** from `main` through GitHub Actions (OIDC). The web app is set up for Vercel, with Vercel Analytics.
- **Tests:** unit, integration and the Playwright e2e suite (against `FakeApi`) all run in CI. Visual baselines are CI's.
- **After each deploy** CI runs the smoke test and the dependency check (Stripe, Bedrock, Gemini, Places, SES from inside the Lambda; see [docs/deploy.md](docs/deploy.md)). The `gdp-dev` dashboard has a Calls out panel timing every outside call.

## Next up

**Analysis cache**, designed in [docs/design/analysis-cache.md](docs/design/analysis-cache.md), not built. Before building it:

- `FallbackBillParser` reports the primary's `model` and `version` even when Gemini answered. Fix that first, or bills and the cache will credit Bedrock with Gemini reads.
- Callum to decide: a global cache or one per user.

## Known problems

- `close` doesn't release `BILLLOCK#` (only `abandon` does), so a closed bill can't be shared again.
- `sessionStore.create` writes META's `ttlAt` as an ISO string; DynamoDB TTL ignores it until a later META write.
- The API still accepts claim changes after a guest has paid.
- Only quantity-1 items can be split.
- SES is in the sandbox: sign-in codes and reports only reach verified addresses. Emails should move to the site's own domain once there is one.
- Google Places returns 403 PERMISSION_DENIED: enable Places API (New) for the key's Google Cloud project, or loosen its API restrictions. Venues fall back to the text on the bill.
- Gemini's free tier allows 20 reads a day, so the fallback is easily used up.
- Nothing has been tried on a real phone with a real Bedrock read since the switch. Bedrock access (use-case form, Marketplace subscription) was completed on 1 Nov.

## Decided, not built

- Accounts optional: guests join with just a name (needs API work).
- Top-ups: more than one payment per guest, so *I had something else* can reopen picking after paying.
- The lead assigning items to other people.
- Bill totals on `GET /v1/me/sessions`.
- Table fee: free bill a month, guests repay it, refund if nobody joins, server-side gate. See [docs/table-fee.md](docs/table-fee.md).

## Housekeeping

- `pr-screenshots` is an orphan branch holding PR images; keep it. Delete other branches once their PR is merged.
