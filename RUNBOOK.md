# Runbook

What to do when something breaks. Each section is named so the alarm
descriptions in `infra/main.ts` can refer to it directly.

This is the dev-environment runbook. Production gets stricter thresholds,
on-call rotation, and post-incident reviews — none of that exists yet.

## Subscribing to alerts

The CDK stack creates an SNS topic but does not bake in any subscribers.
Add yourself once per environment:

```bash
aws sns subscribe --profile gdp-dev \
  --topic-arn "$(aws cloudformation describe-stacks --profile gdp-dev \
    --stack-name GdpBackendDev \
    --query 'Stacks[0].Outputs[?OutputKey==`AlertTopicArnOutput`].OutputValue' \
    --output text)" \
  --protocol email --notification-endpoint "you@example.com"
```

Confirm the email AWS sends you (subject "AWS Notification — Subscription
Confirmation"). After that, every alarm will arrive in your inbox.

To unsubscribe later: open the email and click the unsubscribe link, or
`aws sns unsubscribe --subscription-arn …`.

## Alarms

### `lambda-errors`

**What it means.** The API Lambda threw or crashed in ≥4 invocations
within 5 minutes. Could be runtime exceptions, init failures, or
unhandled rejections.

**Where to look.**

```bash
# Latest log stream
LG="GdpBackendDev-ApiHandlerLogs7BF57C16-Z068uvDbxqWd"
STREAM=$(aws logs describe-log-streams --profile gdp-dev \
  --log-group-name "$LG" --order-by LastEventTime --descending \
  --limit 1 --query 'logStreams[0].logStreamName' --output text)

aws logs get-log-events --profile gdp-dev \
  --log-group-name "$LG" --log-stream-name "$STREAM" \
  --limit 50 --query 'events[].message' --output text | tail -50
```

Or open CloudWatch Logs Insights for the same log group:

```
fields @timestamp, level, requestId, route, msg, err.message
| filter level = "error"
| sort @timestamp desc
| limit 100
```

**Common causes & mitigation.**

| Symptom in logs                               | Likely cause                                         | Mitigation                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Invalid environment variables` at INIT       | CDK env value drifted from zod schema                | Fix `infra/main.ts` env block; redeploy                                                                                                                                      |
| `Dynamic require of …` at INIT                | Bundling missing the createRequire banner            | Check `infra/main.ts` `bundling.banner`                                                                                                                                      |
| `Secrets Manager can't find …` at deploy time | Friendly-name secret missing or wrong region         | `aws secretsmanager list-secrets --profile gdp-dev --region eu-west-2`                                                                                                       |
| Repeated `PARSE_FAILED`                       | Gemini quota / outage / model deprecation            | Check Google AI Studio dashboard; fall back to Flash-Lite                                                                                                                    |
| `PAYMENT_PROVIDER_ERROR`                      | TrueLayer 5xx, auth failure, or signing-key mismatch | Check TrueLayer status page; check Console kid matches `/gdp-{env}/truelayer-signing-kid` SSM and that `gdp-{env}/truelayer-signing-private-key` is the matching private key |

The error envelope's `requestId` cross-references the `x-request-id`
header we return to clients — if a user reports a failure, they can give
you that ID and we can grep CloudWatch for the exact request.

### `lambda-duration`

**What it means.** p99 Lambda duration > 10s sustained for 5 minutes.
Lambda cold starts on Node 22 are typically <1s; warm requests well under
500ms. Sustained p99 above 10s usually means a downstream is slow.

**Where to look.** The trace gives the answer faster than logs. Open
X-Ray service map for `gdp-dev` and look for the long span:

- DDB span > 1s → DDB throttling (cross-check `ddb-throttles` alarm)
- Gemini fetch span > 8s → Gemini saturated; consider switching to
  Flash-Lite or implementing async parse with a poll endpoint
- TrueLayer span > 8s → TrueLayer slow; consider client-side timeouts
- No external span; just Lambda time → likely a CPU loop or sync I/O —
  rare; check recent code changes

**Mitigation.** Same as the underlying cause. The 10s threshold is well
below our 25s Lambda timeout and 30s API Gateway HTTP API limit, so the
alarm fires before the user sees a 5xx.

### `api-5xx`

**What it means.** API Gateway logged > 5 responses with status 5xx
in 5 minutes. Almost always a downstream symptom of `lambda-errors`,
but also fires on:

- API Gateway → Lambda invocation failures (rare; AWS-side)
- Lambda exceeding 30s API Gateway timeout
- Lambda runtime memory exhaustion (we're at 1024MB; 128MB events
  observed — Max Memory Used in CloudWatch reports)

**Where to look.**

```bash
# 5xx count by minute, last hour
aws cloudwatch get-metric-statistics --profile gdp-dev \
  --namespace AWS/ApiGateway --metric-name 5xx \
  --dimensions Name=ApiId,Value=<apiId> Name=Stage,Value='$default' \
  --start-time $(date -u -v-1H '+%Y-%m-%dT%H:%M:%SZ') \
  --end-time $(date -u '+%Y-%m-%dT%H:%M:%SZ') \
  --period 60 --statistics Sum
```

Then jump to the Lambda log group for the same time window.

**Mitigation.** Fix whatever's in `lambda-errors`. If the issue is a
specific deploy, `cdk deploy GdpBackendDev` of an earlier git commit
rolls back.

### `ddb-throttles`

**What it means.** DynamoDB rejected at least one request because the
table couldn't service it fast enough. We're on PAY_PER_REQUEST so this
is usually a sustained-burst problem rather than a provisioned-capacity
one — at v0 traffic this alarm should never fire.

**Where to look.**

```
aws/dynamodb metrics → ThrottledRequests by Operation
```

…then which operation (GetItem / PutItem / TransactWrite / Query) tells
you which access pattern is hot.

**Mitigation.**

- If it's the bill image-hash index PK getting hammered: a hot partition;
  add a sharding suffix.
- If it's the join-code index: same problem; or someone is brute-forcing
  the 6-char code (32^6 ≈ 1B keyspace, but worth checking access logs).
- If sustained: switch the table to provisioned with auto-scaling.

## Common diagnostic flows

### "Live API is returning 5xx"

1. `npm run smoke` against the deployed URL — confirms which routes are
   failing. If everything fails: deploy/init issue. If only specific
   routes fail: route-specific bug.
2. `aws logs tail "GdpBackendDev-ApiHandlerLogs..." --profile gdp-dev --since 5m`
   — see the last 5 minutes of logs in real time.
3. If the Lambda init is failing: check most recent `cdk deploy`. Roll
   back with `git checkout <prior commit> && npm run deploy:dev`.
4. If a specific endpoint: get a `requestId` from a failing curl, grep
   it in logs.

### "A deploy rolled back"

CFN rolled back means the new state failed to provision. Look at:

```bash
aws cloudformation describe-stack-events --profile gdp-dev \
  --stack-name GdpBackendDev \
  --query 'StackEvents[?ResourceStatus==`UPDATE_FAILED`||ResourceStatus==`CREATE_FAILED`].[ResourceType,LogicalResourceId,ResourceStatusReason]' \
  --output table | head -30
```

The first failure is the root cause — subsequent failures are usually
"can't update X because Y also failed".

Common rollback causes:

- Secrets Manager / SSM parameter doesn't exist (CFN can't resolve
  dynamic reference). Fix: create the missing param/secret.
- IAM policy too large or recursive grant. Fix: split into multiple
  policy attachments.
- Lambda asset bundle changed in a way that broke `npm run validate:bundle`
  — but you'd have caught that locally before this happened.

### "Payment is stuck in `pending`"

A payment row exists with `status: pending` but no webhook arrived after
30 minutes. Either TrueLayer never sent the webhook, or our webhook
endpoint rejected it.

1. Check our `/webhooks/truelayer` endpoint logs for that
   `providerPaymentId` — if it appears with 401, JWS verification
   failed (likely a JWKS rotation or our `path` arg drifted from the
   route mount). If it doesn't appear, TrueLayer never delivered.
2. TrueLayer dashboard → Webhook deliveries — see retry attempts and
   response codes.
3. If TrueLayer says it delivered but we don't have it: our endpoint
   was unreachable (Lambda init failure?) or our return status caused
   them to give up.

**Mitigation:** worst case, manually `aws dynamodb update-item …` to
flip the payment status based on the truth in TrueLayer's dashboard.
For v0 with a mock provider this code path is exercised by tests, not
real money.

## Tools you'll probably want

```bash
# Tail logs live
aws logs tail "GdpBackendDev-ApiHandlerLogs..." --profile gdp-dev --follow --since 5m

# All alarms current state
aws cloudwatch describe-alarms --profile gdp-dev \
  --alarm-name-prefix gdp-dev- \
  --query 'MetricAlarms[].[AlarmName,StateValue,StateReason]' --output table

# Stack outputs (api url, table name, etc.)
aws cloudformation describe-stacks --profile gdp-dev \
  --stack-name GdpBackendDev --query 'Stacks[0].Outputs' --output table

# Recent deploys (CFN history)
aws cloudformation describe-stack-events --profile gdp-dev \
  --stack-name GdpBackendDev --max-items 10 \
  --query 'StackEvents[].[Timestamp,ResourceStatus,LogicalResourceId,ResourceStatusReason]' \
  --output table
```
