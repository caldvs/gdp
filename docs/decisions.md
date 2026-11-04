# Decisions

What's been decided and still holds. Change a decision here in the same commit as the code that changes it. Don't undo one without asking Callum.

Code comments cite the two numbered decisions as ADR-0002 and ADR-0006.

## ADR-0002: Bank details stay on the lead's device

The lead's sort code, account number and name are kept in their browser, not on the server. They reach guests inside the join link's `#p=` fragment, which browsers never send to a server.

- The share flow asks for them on `/payout-account` before the QR. They're kept in `sessionStorage` (gone when the tab closes) unless the lead ticks _Remember on this device_, which uses `localStorage`. They aren't encrypted at rest.
- The guest's pay screen uses the details from the link.
- The fragment (and a sign-in link's `#t=` token) leaves the address bar as soon as the app's JavaScript runs, before anything renders (`apps/web/lib/secretFragment.ts`), and Vercel Analytics is sent URLs without a fragment (#147).
- `PUT /v1/me/payout-account` is deprecated: it validates and returns 200 but stores nothing.
- **Guests check the link's details** (#151, 4 Nov 2026). When the lead's share page shows a QR or link with bank details, their device sends the session `payoutCheck`: PBKDF2-SHA256 (100k rounds) of name, sort code, account number, Monzo and Revolut, salted with the session id. Never the details. A guest's app recomputes it from the `#p=` it got; if it doesn't match, the pay page says *These aren't Sam's bank details* and shows none of them, and a guest's share page doesn't pass them on. Sessions with no `payoutCheck` (older ones, or a lead whose device couldn't send it) show the link's details as before. This keeps ADR-0002: the server holds a slow, salted fingerprint that can't redirect a payment and isn't cheap to reverse.

Why: the server never holds data that would let someone redirect payments, and the lead doesn't need an account.

## ADR-0006: Splits by ways

A shared item (a bottle of wine) is split into `ways`, the number of people who shared it. Each sharer owes price ÷ ways; the remainder penny goes to the lowest `userId`.

- Settings live in one `SHARE#<itemId>` row per item, with a `version` for optimistic locking and the last 10 activity entries.
- Whoever starts the split sets `ways`. People in the split can change it (`PUT /v1/sessions/{id}/shares/{itemId}`), but not below the number already in, and not once any of them has paid.
- Joining a full split adds a way. Leaving frees the spot.
- Only quantity-1 items can be split (`ITEM_NOT_SHAREABLE` otherwise).
- `splitShare` in the API and `sharePence` in `packages/core` must give the same answer.

## Product

- **The name is Pay Me Back** (#111, 2 Nov 2026), written as three words in every place people see it, short form included (tab titles, emails). The site is `paymeback.dev`. The logo is a coral coin whose £ rolls through €, $ and ¥ (#127).
- **Web only.** No native app. The UI is plain mobile web, deliberately not iOS-styled.
- **As few words as possible** on every screen.
- **Accounts are optional** (decided 31 Oct). Not built yet: everyone still signs in with an emailed link. Name-only guest join needs API work.
- **Up to 99 people** per bill (#135, 3 Nov 2026; was about 10).
- **Sign in with an emailed link, not a code** (#119, decided 1 Nov 2026, built 2 Nov 2026). The email carries `<site>/sign-in/verify#t=<token>`; the token is in the fragment so it never reaches a server or proxy log. It works once, for 15 minutes, and only its hash is stored. Opening it twice or late shows *Link expired* with *Send a new link*.
- **The tab that asked shows a number, and the link asks about it** (#138, 4 Nov 2026). Without it, someone could start a sign-in for another person's email and, if that person tapped the genuine link, the stranger's tab was signed in as them. Now `/email/start` returns a two-digit `code` that the asking tab shows under *Check your email*; the email says it signs in the tab or device that asked, showing that number; and the link's page asks *Signing in the tab showing 47?* with *Yes* / *No* before anything is signed in. *No* cancels the request (the asking tab sees *Link expired*). Exempt, test and local sign-ins are unchanged.
- **The tab that asked carries on** (Callum, 1 Nov 2026). A link always opens a new tab, often in the mail app's browser, so the asking tab (which says only *Check your email*) polls `POST /v1/auth/email/requests` every 2 s with a secret `requestId` from `/email/start`, signs itself in once the link is opened, and goes on to where it started (a join link's `#p=` fragment included, since it never left that tab). The link's own tab is signed in too and says *Go back to your other tab*, with *Continue here* in case that tab was closed. Only the `requestId` collects the asking tab's session, so a link alone can't sign in someone else's tab. The link points back at the site the user asked from only when its origin is exactly one of the API's listed link bases (`SIGN_IN_LINK_BASES`: dev has test.paymeback.dev and localhost; prod has none), else `APP_BASE_URL` (#149). Previews get `APP_BASE_URL` links, since a wildcard can't be trusted with a sign-in token.
- **Sign-in links are limited** (2 Nov 2026; widened 4 Nov, #146): per address one every 30 seconds and at most 5 in 15 minutes, counted without `+tags` and, for Gmail, without dots; at most 20 an hour from one IP address (API Gateway's `sourceIp`); and 1000 an hour in all (`RATE_LIMITED`, 429). Stops the app being used to flood an inbox or spray addresses, which SES would count against us. Each link stands on its own: sending a new one doesn't cancel the last. Not done: Turnstile after several sends from one IP, and SES bounce/complaint alarms.
- **Sign out is everywhere** (#155, 4 Nov 2026). Session tokens carry the user row's `tokenVersion`; every request checks it (one GetItem), and *Sign out* calls `POST /v1/me/sign-out`, which bumps it, so every token the account holds, on any device, stops working. Signing out after being idle only clears this device.
- **Join codes are limited per user** (#151): 30 lookups every 10 minutes (`RATE_LIMITED`), so guessing codes is slow.
- **Party size is for show** (#64, decided 2 Nov 2026). The lead can say how many are eating, themselves included (2–99, `expectedDiners`), on their table any time before it closes (*How many eating?*); unset on a table made without it. It only shows as "3 of 4 joined" and, once everyone's in, flags what's still unclaimed. It never changes the money maths: service is still split by what each person claims.
- **The lead collects.** Guests pay the lead by their own bank transfer and the lead confirms each payment. The app never holds money. Pay-by-bank (TrueLayer) was dropped for good (1 Nov 2026): no payment provider touches diner money, and Stripe takes only the lead's platform fee.
- **Trust-based payments.** Guests pay while the bill is still open for claiming. There's no lock-claims step in the UI.
- **Top-ups** (#121, decided 2 Nov 2026). What matters is that the lead knows they got everything they're owed and a guest knows they're good to leave. A guest who has paid can tap *I had something else*, claim more and pay just the difference (new items plus their share of service). Every payment, first or top-up, is confirmed by the lead on its own, and payments can overlap (a top-up before the first is confirmed). A guest is settled once nothing is due and every payment is confirmed. What anyone has paid never changes: a guest can't drop their claims below what they've sent (`ALREADY_PAID_FOR`), nobody is credited when someone else claims, and a split someone has paid for can't take more people. "Sent" means confirmed or marked as sent by the guest; a payment opened on the pay page but not sent is reused if the amount still matches, else replaced. Each guest's payments are a `payments[]` list on their participant row; `payment` is the latest state across it.
- **The lead can edit the bill at any time before close, including lines a guest has paid for** (decided 1 Nov 2026). No freeze on paid lines; the only edit refused is lowering a quantity below what's been claimed. Removing a line drops claims and splits on it.
- **Only the lead closes a bill.** Everyone paying doesn't settle it, because a late guest may still take a split seat or a leftover item. Unclaimed items go on the lead. Payments are still accepted after closing. Closing releases the bill, so the lead can edit it or share it again; the closed table keeps the version it was pinned to.
- **Scanning uses our own camera, then a photo check** (#59, #60). *Scan a bill* opens a full-screen camera with a bill-shaped guide; where the browser has no camera API or access is refused, it falls back to the phone's camera app. Every photo, taken or chosen, is shown as *All in?* with *Retake* and *Use photo*; nothing uploads until *Use photo*.
- **Nothing asked while the bill is read** (#61, 2 Nov 2026; changed 3 Nov, #135, #136). The reading screen is R2 (the photo, the bill's rows filling in) and asks nothing; Review bill opens when it's read, and Bills' *Bill read* row goes straight there. The place comes from the receipt alone (and the address lookup, #62): with none, none is shown or asked for, though the lead can still change one that was read. Party size is set on the lead's table.
- **Bills keep their shape.** Every line stays in place and changes state as it's claimed.
- **Discount lines go into the item they came from** (decided 1 Nov 2026). A minus line on the bill ("Coffee & Cannoli LRG −4.00") lowers the price of the item it belongs to, so whoever claims that item gets the discount. If the reader can't tell which item, the discount is shared across every line by price. No line is ever below £0.
- **Deposits are left out of the split** (decided 1 Nov 2026). The lead usually paid the deposit, so the lead has paid the whole bill (deposit plus balance) and guests owe their full share. The bill's total is the total before the deposit comes off.
- **Each meal settles on its own.** No balances carried between meals; history is a record, not a ledger.
- **No nudging or chasing** unpaid guests.
- **Exempt accounts** (decided 1 Nov 2026; tightened 3–4 Nov, #137). Email addresses on `TABLE_FEE_EXEMPT_EMAILS` never pay the platform fee, and sign in with just their email, no link. The list is a GitHub environment **secret** only (a variable would be printed in public run logs), and prod's entry is a hard-to-guess address used only for testing live, not anyone's real email (Callum, 3 Nov 2026): knowing the address is what signs you in, so it's treated like a password. Bank details stay on the device either way.
- **Platform fee.** The lead pays £2 (£3 over £100) by Stripe's embedded form before the QR. Screens call it the *platform fee* (#128, 3 Nov 2026); code, routes, Stripe lookup keys and `TABLE_FEE_*` settings keep the old name.
  - **One free bill a month per lead** (confirmed 1 Nov 2026, built 4 Nov 2026, #139), shown as a **credit**: "Spend 1 credit & get QR code", "1 credit left · you get 1 free each month", "1 credit spent · next credit 1 Dec", "No credits left this month"; the account shows "Credits · 1 left". Months are calendar months in UK time; the next credit comes on the 1st.
  - After that, everything up to the QR still works without paying (scan, check and edit the bill, bank details); the fee is due at the QR.
  - **The server enforces it** (#139): `/share` needs the bill's paid fee, an exempt lead or the month's credit, else 402 `TABLE_FEE_REQUIRED`. **One fee, one share**: a fee pays for the session it shared and no other, so sharing a bill again after closing it costs a new fee (or the credit). A paid fee is used before the credit.
  - **Refund if nobody joins, at close or bin only** (#132, 4 Nov 2026): no time limit for now, as the safe default; Callum can revisit. A credit spent on a bill nobody joined is handed back the same way.
  - Not built: guests repay the fee in what they owe. Until then no screen says they do ("recovered from your guests" and "Your guests pay this back" from the board are left out).

  See [table-fee.md](table-fee.md).

- **Bill reports.** Closing a bill emails every diner what they had and paid; the lead also gets what each diner paid for. Emails should come from the site's own domain once there is one.

## Technical

- **No pull requests** (decided 1 Nov 2026). Work is committed and pushed straight to `main` after running the checks locally (`CLAUDE.md`, *Pushing to main*). A red `gate` or failed deploy on main is fixed or reverted at once. The repo is public, so Actions minutes are free.

- **Money is integer pence, GBP only.**
- **One DynamoDB table**, single-table design. Keys and access patterns: [architecture/data-model.html](architecture/data-model.html).
- **One Lambda** behind API Gateway serves every route. `apps/api/openapi.yaml` is the contract; client types are generated from it.
- **Bills are versioned.** Every edit writes a new `V#nnn` row plus a `LATEST` mirror. A session pins the version it started with.
- **Bill reading** is Claude Sonnet 4.6 on Bedrock, and nothing else: no fallback reader and no Google services (decided 1 Nov 2026). One model for every call, for simplicity: on the Gusto receipt Sonnet read all 44 lines right where Haiku 4.5 got 39, at about 3× the cost (~4¢ a bill), which the platform fee covers (switched 1 Nov 2026). Bedrock reads the venue's name and printed address off the bill and never guesses one.
- **Bill reads are capped at 20 a day per account** (#145, 4 Nov 2026), counting only reads that reach the model: a photo read before comes from the cache and is free. Past that, `RATE_LIMITED` (429) until midnight UTC. Stops a loop (or a stolen session) running up Bedrock costs; a real lead reads a few bills a month.
- **Venue lookup** is Amazon Location Service (Places), which fills in the full address and coordinates from what Bedrock read. Answers are cached in `VENUEQ#` rows with no expiry (decided 1 Nov 2026), so it's queried with `IntendedUse: Storage` as AWS's terms require. A failed or vague lookup leaves the venue as read off the bill.
- **Nearby places** (#62, 2 Nov 2026): `GET /v1/venues/nearby` lists up to 5 food and drink places within 300 m from Amazon Location's `SearchNearby`. **The lead's position is never stored and is logged rounded at most**: the search and its 30-day `NEARQ#` cache use the position rounded to 3 decimal places (about 110 m), with nothing about who asked; distances are measured from the real position in memory only. A failed search returns an empty list, so the app falls back to asking for the name.
- **Bills are read in the background** (1 Nov). `POST /v1/bills/reads` returns at once and the Lambda invokes itself to do the read (45s budget, no retries); the app polls the read and the lead can go back to Bills meanwhile. The read is its own `READ#` row; the bill is only created when the read works. The synchronous `POST /v1/bills/parse` stays, with 22s to fit under API Gateway's 30s; running out is a 504 `PARSE_TIMEOUT`.
- **Polling, not push.** Session screens poll; there are no websockets or notifications.
- **Security headers** (#150, 4 Nov 2026). The web app sends a CSP (`packages/core/src/lib/securityHeaders.ts`: its own API, S3, Stripe, Vercel Analytics), `frame-ancestors 'none'` and `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`, and a Permissions-Policy allowing only the camera and location. Scripts allow `'unsafe-inline'` (nonces would make every page render per request) and `'unsafe-eval'` (the HEIC converter needs it). The API sends `hono/secure-headers`. The session token stays in `localStorage`: an HttpOnly cookie wasn't done.
- **Redirects after sign-in** go only to a path on this site (`safeInternalPath`): no `//`, `\`, control characters or their percent-encoded forms (#148).
- **No GPS in committed images** (#156): the pre-commit hook refuses staged images with a GPS position (`scripts/check-image-gps.mjs`).
