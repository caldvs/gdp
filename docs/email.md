# Email (Amazon SES)

How the app sends email, what's set up in AWS and DNS, and what's left. Dev and prod share one AWS account (eu-west-2), so everything here covers both.

## What the app sends

Only two kinds of email, both because a user asked for them:

- **Sign-in codes** (`POST /v1/auth/email/start`). Limited per address: one every 30 seconds, at most 5 in 15 minutes (`RATE_LIMITED`, 429; `src/storage/otpStore.ts`).
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

## Leaving the sandbox

A new SES account is in the **sandbox**: it only sends to verified addresses, at most 200 a day. Real guests can't get sign-in codes until it's out.

- **Requested 2 Nov 2026**, from the SES console (Get set up → *Request production access*): mail type *Transactional*, website `https://paymeback.dev`. Status **under review**; AWS says up to 96 hours.
- The console only offers the request once a sending domain is verified, which is why the domain above came first.
- The form asked for no use-case text. If AWS writes back asking for one, the text drafted on #76 describes what we send and how bounces and complaints are handled.
- The form's acknowledgement confirms we only email people who asked for it and handle bounces and complaints. We rely on SES's **account-level suppression list** for that: check it's on (SES console → Suppression list, *bounces and complaints*).

## When production access is approved

1. Switch the sender to the domain (both environments):

   ```sh
   aws ssm put-parameter --profile gdp-dev --overwrite --type String \
     --name /gdp-dev/ses-from-email --value noreply@paymeback.dev
   aws ssm put-parameter --profile gdp-dev --overwrite --type String \
     --name /gdp-prod/ses-from-email --value noreply@paymeback.dev
   ```

2. Redeploy dev (any push to `apps/api`, or API Deploy → dev) and prod (API Deploy → prod). CDK reads the parameter at deploy time.
3. The dependency check's SES line should read verified and out of the sandbox.
4. Sign in on the deployed site with an address that was never verified in SES: the code should arrive.
5. Close #126, then build sign-in by link (#119), which waits on this.

## Until then

- Testers' addresses must be verified one by one in SES (Identities → Create identity → Email address), or use the test accounts on dev (`@test.invalid`, no email sent).
- The daily cost email's recipient must stay verified.
