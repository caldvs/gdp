# Runbook

What to do when something breaks in the deployed API. The alarm descriptions in `infra/main.ts` point at the section names below, so keep them.

Commands use the `gdp-dev` profile and the `GdpBackendDev` stack. Production doesn't exist yet.

## Start here

- **Dashboard:** CloudWatch → Dashboards → `gdp-dev` (or the stack's `DashboardUrlOutput`). The top rows are API, Lambda and DynamoDB metrics. The log panels below show errors and warnings, recent requests, requests by route, bill reading, emails/sign-in/payments, and crashes and timeouts.
- **Logs:**

  ```bash
  LG=$(aws cloudformation describe-stack-resources --profile gdp-dev --stack-name GdpBackendDev \
    --query "StackResources[?ResourceType=='AWS::Logs::LogGroup'].PhysicalResourceId" --output text)
  aws logs tail "$LG" --profile gdp-dev --since 15m --follow
  ```

- **One request:** every response carries `x-request-id`, and error bodies include `requestId`. Search the logs for it.
- **Traces:** X-Ray tracing is on; the service map shows which downstream call was slow.
- **Smoke test:** `npm run smoke -w apps/api -- <api-url>` shows which routes fail.
- **Dependencies:** `AWS_PROFILE=gdp-dev npm run check:deps -w apps/api <function-name>` checks Stripe, Bedrock and SES from inside the deployed function (CI runs it after every deploy). The dashboard's _Calls out_ panel shows each one's failures and timings (`event: dep.call`).

## Getting alerts

The stack creates the SNS topic `gdp-dev-alerts` with no subscribers. Subscribe once:

```bash
aws sns subscribe --profile gdp-dev --protocol email --notification-endpoint you@example.com \
  --topic-arn "$(aws cloudformation describe-stacks --profile gdp-dev --stack-name GdpBackendDev \
    --query "Stacks[0].Outputs[?OutputKey=='AlertTopicArnOutput'].OutputValue" --output text)"
```

Then confirm the email AWS sends.

## Alarms

### lambda-errors

More than 3 Lambda errors in 5 minutes. Open the _Errors and warnings_ and _Crashes and timeouts_ panels.

| In the logs                              | Likely cause                                  | Fix                                            |
| ---------------------------------------- | --------------------------------------------- | ---------------------------------------------- |
| `Invalid environment variables` at start | Lambda env doesn't match `src/config/env.ts`  | Fix the env block in `infra/main.ts`, redeploy |
| `Dynamic require of …`                   | Bundle banner missing                         | Check `bundling.banner` in `infra/main.ts`     |
| `Task timed out after 30`                | A downstream call hung (usually bill reading) | See lambda-duration                            |
| `PAYMENT_PROVIDER_ERROR`                 | Only with TrueLayer, which isn't in use       | Check `PAYMENT_PROVIDER` is `manual`           |

### lambda-duration

p99 over 10 seconds for 5 minutes. Bill reading is almost always the cause: a parse takes 3–10 seconds normally, and the Lambda and API Gateway both stop at 30.

- Check the _Bill reading_ panel for slow or failing Bedrock calls.
- If it's every request, look at the X-Ray map for the slow span.

### api-5xx

More than 5 server errors in 5 minutes. Usually the same cause as lambda-errors; it also fires when a request passes API Gateway's 30-second limit. Use _Requests by route and status_ to see which route.

To roll back, check out the last good commit and run `npm run deploy:dev -w apps/api`.

### ddb-throttle

DynamoDB throttled at least one request. The table is on-demand, so this means a sudden burst. The _DDB throttles_ panel shows the operation. One hot key (a join code or image hash being hammered) points at abuse rather than load.

## Common problems

### Bills won't read

`PARSE_FAILED` or slow parses:

- `AccessDeniedException` from Bedrock: model access for Claude Haiku 4.5 isn't enabled in the account, or the inference profile changed. Bedrock console → Model access.
- `ThrottlingException`: Bedrock quota. There's no fallback reader, so bills fail until it clears. Ask for a quota increase.

`PARSE_LOW_CONFIDENCE` isn't an outage: the photo was unreadable.

### Sign-in codes don't arrive

Look for `otp.start.failed` or `email.sent` in _Emails, sign-in and payments_. A new SES account is in the sandbox and only sends to verified addresses: request production access or verify the tester.

### Bill reports don't arrive

`report.failed` in the same panel. Same SES checks as above.

### A deploy rolled back

```bash
aws cloudformation describe-stack-events --profile gdp-dev --stack-name GdpBackendDev \
  --query "StackEvents[?contains(ResourceStatus,'FAILED')].[LogicalResourceId,ResourceStatusReason]" \
  --output table | head -20
```

The first failure is the cause. Usually a missing secret or SSM parameter: create it in eu-west-2 and redeploy.
