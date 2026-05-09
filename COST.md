# Cost model

Concrete numbers for what `gdp-backend` costs at various traffic levels.
Updated when the architecture changes; not when AWS prices do (current
prices are ~mid-2026 levels, sanity-check before quoting).

## Today's spend

Account `712716444007` was created today; Cost Explorer needs ~24 hours
to ingest before reporting. Until then, the running spend is whatever
the constant costs below add up to plus pennies of variable cost from
the smoke-testing we did during deploy.

Refresh later with:

```bash
aws ce get-cost-and-usage --profile gdp-dev \
  --time-period Start=$(date -u -v-30d '+%Y-%m-%d'),End=$(date -u '+%Y-%m-%d') \
  --granularity MONTHLY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

## Constant monthly costs (zero traffic)

These are paid even if nobody uses the API.

| Resource                     | Unit cost                      | Quantity                             | $/month          |
| ---------------------------- | ------------------------------ | ------------------------------------ | ---------------- |
| Secrets Manager secrets      | $0.40 / secret / month         | 3                                    | $1.20            |
| CloudWatch alarms            | $0.10 / alarm / month          | 4                                    | $0.40            |
| SNS topic                    | $0 base, $0.50 / 1M deliveries | 1 (no deliveries unless alarm fires) | $0.00            |
| SSM Parameter Store standard | free                           | 2                                    | $0.00            |
| DynamoDB table on-demand     | free at rest below storage min | 1                                    | $0.00            |
| S3 bucket                    | free below 0 bytes             | 1                                    | $0.00            |
| Lambda function              | free at rest                   | 1                                    | $0.00            |
| API Gateway HTTP API         | free at rest                   | 1                                    | $0.00            |
| **Total constant**           |                                |                                      | **~$1.60/month** |

A $5 monthly AWS Budget alert is configured at the account level — it
sits comfortably above the $1.60 constant baseline and the variable
costs at v0 traffic, so it should only fire if traffic ramps unexpectedly
or a misconfiguration starts burning resources. If we approach $5/month
sustained, revisit the cost-levers section below before raising it.

## Per-session variable costs

Assume one "session" = one bill, photographed once, 4 diners, 3 of whom
pay (the lead diner is `self_paid`). Rough request counts:

| Per-session resource use            | Approximate count                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Image upload (300KB JPEG)           | 1 PUT, 1 GET on S3                                                                                      |
| Bill parse Gemini call              | 1                                                                                                       |
| API Gateway requests                | ~30 (uploads, parse, session create, share, joins, claims, lock-claims, payments, GET sessions polling) |
| Lambda invocations                  | ~30                                                                                                     |
| Lambda compute (avg 500ms @ 1024MB) | ~15 GB-seconds                                                                                          |
| DynamoDB writes                     | ~25 (bill versions, session, participants, payments, idempotency)                                       |
| DynamoDB reads                      | ~50                                                                                                     |
| CloudWatch Logs ingested            | ~30KB                                                                                                   |
| TrueLayer payments                  | 3 (paid via mock or real)                                                                               |

Cost per session on AWS only (excluding Gemini and TrueLayer):

| Item                    | Unit cost         | Per session          |
| ----------------------- | ----------------- | -------------------- |
| API Gateway HTTP        | $1.00 / 1M        | $0.00003             |
| Lambda invocations      | $0.20 / 1M        | $0.000006            |
| Lambda compute          | $0.0000167 / GB-s | $0.00025             |
| DynamoDB writes         | $1.25 / 1M        | $0.00003             |
| DynamoDB reads          | $0.25 / 1M        | $0.0000125           |
| S3 PUT                  | $0.005 / 1k       | $0.000005            |
| S3 GET                  | $0.0004 / 1k      | $0.0000004           |
| S3 storage (300KB ~1mo) | $0.023 / GB / mo  | $0.000007            |
| CloudWatch Logs ingest  | $0.50 / GB        | $0.000015            |
| **AWS total**           |                   | **~$0.0004/session** |

External costs:

| Item              | Free tier    | Paid rate                                        | Per session at paid                   |
| ----------------- | ------------ | ------------------------------------------------ | ------------------------------------- |
| Gemini 2.5 Flash  | 250 req/day  | $0.000075 / 1K input tokens, $0.0003 / 1K output | ~$0.005 (image + structured response) |
| TrueLayer payment | sandbox free | live: ~£0.10 / payment                           | ~£0.30/session × 3 payers             |

Gemini is the dominant per-session cost in production. AWS is rounding
error. TrueLayer fees, when live, dwarf both.

## Projected monthly cost at scale

AWS-only (Gemini and TrueLayer pricing depend on tier negotiations):

| Sessions / month | AWS cost | Notes                                                                                          |
| ---------------- | -------- | ---------------------------------------------------------------------------------------------- |
| 100              | $1.64    | Constant + ~$0.04 variable. Stays in Lambda + DDB free tiers.                                  |
| 1,000            | $2.00    | Lambda free tier (1M req/mo) covers ~30k sessions.                                             |
| 10,000           | $5.60    | API Gateway becomes the dominant variable line.                                                |
| 100,000          | $42      | API Gateway $30, Lambda compute $25, DDB $5, CloudWatch logs $7 — log volume starts mattering. |
| 1,000,000        | $400     | Move logs to retention 1 week, sample X-Ray, consider Lambda Power Tuning.                     |

These are rough — the numbers shift by ±30% depending on log verbosity,
participant-fan-out, and how aggressively the mobile client polls.

## Free tier coverage (first 12 months)

The AWS 12-month free tier this account is eligible for covers, monthly:

- 1M Lambda requests + 400,000 GB-seconds compute
- 5GB S3 storage + 20k GET + 2k PUT
- 25GB DynamoDB + 25 RCU/WCU permanent
- 10 CloudWatch metrics, 1M API requests, 5GB logs ingested + storage
- $0 SNS for first 1k email deliveries

For ~v0 traffic (under 1k sessions/month) we'll be entirely covered by
free tier _except_ the Secrets Manager and alarm constants — which
aren't free-tier eligible. So at low traffic, expect $1.60/month
indefinitely, climbing modestly with usage.

After the 12-month free tier expires, the projection table above
applies in full.

## Cost levers (what to pull if spend climbs)

In rough order of "most savings, least pain":

1. **Drop a CloudWatch alarm.** Each is $0.10/month. The
   `lambda-duration-p99` alarm fires rarely; `ddb-throttles` virtually
   never at our traffic. Could remove either. Saves $0.10–0.20/month.
2. **Shorten log retention** from 1 month to 1 week. Logs are 95% of
   variable observability cost at scale.
3. **Move Secrets Manager → SSM SecureString** for the three secrets.
   Same encryption, free instead of $0.40/secret. Trade-off: SSM
   SecureString isn't first-class for runtime fetch via SDK; adds code
   complexity. Worth it above $5/month total spend, not before.
4. **Run X-Ray at lower sample rate** (default is 5% of traces; can
   drop to 1%). Halves trace storage cost.
5. **Switch Gemini → Groq Llama 3.2 Vision** for OCR. Free tier 1k/day
   rather than 250/day. Quality drop is real but tolerable for v0.
6. **Compress images more aggressively client-side.** 200KB instead of
   300KB → 33% less S3 storage, same Gemini quality.
7. **Reserved capacity / Savings Plans** for Lambda. Only worth
   considering above ~1M GB-seconds/month sustained.
8. **Move to Cloudflare Workers + D1.** Genuinely cheaper at scale
   (free up to 100k req/day, no per-GB-s charge), but a meaningful
   port. Worth modelling at $50+/month spend, not before.

## What's NOT in this doc

- Real billing data (account is <24h old; come back when Cost Explorer
  has a week of usage)
- Mobile client costs (Apple/Google developer accounts, App Store fees,
  Expo EAS Build) — those live in the mobile project's cost doc when
  it exists
- TrueLayer pricing tier — depends on commercial agreement; sandbox is
  free
