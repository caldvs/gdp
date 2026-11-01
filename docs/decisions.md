# Decisions

What's been decided and still holds. Change a decision here in the same PR as the code that changes it. Don't undo one without asking Callum.

Code comments cite the two numbered decisions as ADR-0002 and ADR-0006.

## ADR-0002: Bank details stay on the lead's device

The lead's sort code, account number and name are kept in their browser, not on the server. They reach guests inside the join link's `#p=` fragment, which browsers never send to a server.

- The share flow asks for them on `/payout-account` before the QR. They're kept in `sessionStorage` (gone when the tab closes) unless the lead ticks _Remember on this device_, which uses `localStorage`. They aren't encrypted at rest.
- The guest's pay screen uses the details from the link.
- `PUT /v1/me/payout-account` is deprecated: it validates and returns 200 but stores nothing.
- The API needs a beneficiary only for TrueLayer, which isn't in use.

Why: the server never holds data that would let someone redirect payments, and the lead doesn't need an account.

## ADR-0006: Splits by ways

A shared item (a bottle of wine) is split into `ways`, the number of people who shared it. Each sharer owes price ÷ ways; the remainder penny goes to the lowest `userId`.

- Settings live in one `SHARE#<itemId>` row per item, with a `version` for optimistic locking and the last 10 activity entries.
- Whoever starts the split sets `ways`. People in the split can change it (`PUT /v1/sessions/{id}/shares/{itemId}`), but not below the number already in, and not once any of them has paid.
- Joining a full split adds a way. Leaving frees the spot.
- Only quantity-1 items can be split (`ITEM_NOT_SHAREABLE` otherwise).
- `splitShare` in the API and `sharePence` in `packages/core` must give the same answer.

## Product

- **Web only.** No native app. The UI is plain mobile web, deliberately not iOS-styled.
- **As few words as possible** on every screen.
- **Accounts are optional** (decided 31 Oct). Not built yet: everyone still signs in with an email code. Name-only guest join needs API work.
- **Up to about 10 people** per bill.
- **The lead collects.** Guests pay the lead by their own bank transfer. The app never holds money. The deployed API runs `PAYMENT_PROVIDER=manual`; the TrueLayer code stays but needs a live contract.
- **Trust-based payments.** Guests pay while the bill is still open for claiming. There's no lock-claims step in the UI.
- **Only the lead closes a bill.** Everyone paying doesn't settle it, because a late guest may still take a split seat or a leftover item. Unclaimed items go on the lead. Payments are still accepted after closing. Closing releases the bill, so the lead can edit it or share it again; the closed table keeps the version it was pinned to.
- **Bills keep their shape.** Every line stays in place and changes state as it's claimed.
- **Each meal settles on its own.** No balances carried between meals; history is a record, not a ledger.
- **No nudging or chasing** unpaid guests.
- **Table fee.** The lead pays £2 (£3 over £100) by Stripe's embedded form before the QR. Decided but not built:
  - one free bill a month
  - guests repay the fee in what they owe
  - a refund if nobody joins

  See [table-fee.md](table-fee.md).

- **Bill reports.** Closing a bill emails every diner what they had and paid; the lead also gets what each diner paid for. Emails should come from the site's own domain once there is one.

## Technical

- **Money is integer pence, GBP only.**
- **One DynamoDB table**, single-table design. Keys and access patterns: [architecture/data-model.html](architecture/data-model.html).
- **One Lambda** behind API Gateway serves every route. `apps/api/openapi.yaml` is the contract; client types are generated from it.
- **Bills are versioned.** Every edit writes a new `V#nnn` row plus a `LATEST` mirror. A session pins the version it started with.
- **Bill reading** is Claude Haiku 4.5 on Bedrock, and nothing else: no fallback reader and no Google services (decided 1 Nov 2026). The venue's name and address are what Bedrock reads off the bill; an address that isn't printed is left blank rather than looked up or guessed.
- **Polling, not push.** Session screens poll; there are no websockets or notifications.
