# Email (Amazon SES)

How the app sends email, what's set up in AWS and DNS, and what's left. Dev and prod share one AWS account (eu-west-2), so everything here covers both.

## What the app sends

Only two kinds of email, both because a user asked for them:

- **Sign-in codes** (`POST /v1/auth/email/start`: 6 digits, in the subject). Limited per address: one every 30 seconds, at most 5 in 15 minutes (`RATE_LIMITED`, 429; `src/storage/signInCodeStore.ts`).
- **Bill reports**: when someone taps *Email me*, and to everyone when the lead closes the bill (`src/services/sessions/reportService.ts`).

No marketing or bulk email. The sender is `src/services/email/` (SES v2 when deployed, printed to the console locally).

## Where things are set

| What | Where |
| --- | --- |
| Sender address | SSM `/gdp-dev/ses-from-email`, `/gdp-prod/ses-from-email` (read by CDK into `SES_FROM_EMAIL`) |
| Send permission | `ses:SendEmail`, `ses:SendRawEmail` on the account's identities (`infra/main.ts`) |
| Daily cost email recipient | SSM `/gdp/cost-report-to` (`infra/costReport.ts`) |
| Health | The dependency check after every deploy reports whether the sender is verified and whether SES is in the sandbox |

## The sending domain: paymeback.dev

Set up 2 Nov 2026:

- **Domain identity** `paymeback.dev` in SES eu-west-2: **verified**. Easy DKIM, RSA 2048, DKIM signing on.
- **DKIM records** in Vercel DNS (paymeback.dev is on Vercel nameservers), commented "SES Easy DKIM for paymeback.dev (#76)":

  | Type | Name | Value |
  | --- | --- | --- |
  | CNAME | `vpo742dj4grbufndpbd5srfzdayg6d2w._domainkey` | `vpo742dj4grbufndpbd5srfzdayg6d2w.dkim.amazonses.com` |
  | CNAME | `3jfglcfq3yj63xe25uez4zep2ppgtvn3._domainkey` | `3jfglcfq3yj63xe25uez4zep2ppgtvn3.dkim.amazonses.com` |
  | CNAME | `ah6mhuyvcirwyqwhylc7mjuss6oi2h4w._domainkey` | `ah6mhuyvcirwyqwhylc7mjuss6oi2h4w.dkim.amazonses.com` |

  Don't delete them: SES checks them regularly and the domain stops verifying (and signing) without them.
- **Not set up yet:** a custom MAIL FROM domain and a DMARC record. Both improve deliverability; neither is needed for production access.

## Out of the sandbox

Production access was granted on 2 Nov 2026 (support case 179364906300659) for eu-west-2: any address, up to 50,000 a day at 14 a second. Mail type *Transactional*, website `https://paymeback.dev`.

- Both environments send from `noreply@paymeback.dev` (the SSM parameters above), DKIM-signed by the domain, with the sender name *Pay Me Back* (`EMAIL_FROM_NAME` in `src/services/email/factory.ts`).
- Bounces and complaints go on SES's **account-level suppression list**, which is on. The app doesn't see them yet.
- The other regions (eu-west-1, us-east-1) are still in the sandbox; we don't send from them.
- Need more? Request a higher quota before it's reached (SES console → Account dashboard).
