# Web app (`apps/web`)

Next.js 16 (App Router), React 19, TanStack Query. Mobile-first, plain mobile-web UI. Deployed to Vercel.

Next 16 differs from older versions: read [AGENTS.md](AGENTS.md) before changing framework code.

## Screens

| Route | What it is |
| --- | --- |
| `/` | Bills home: open and past bills |
| `/capture` | Photograph or choose a bill |
| `/confirm-bill/[billId]` | Check and edit the read items, then *Pay fee & get QR code* or *Continue* |
| `/payout-account` | The lead's bank details, kept in the browser |
| `/table-fee/[billId]` | Stripe's embedded form for the platform fee |
| `/session/[id]` | The bill: the lead's table, or the guest's *What did you have?* |
| `/session/[id]/share` | QR, join code, copy or share the link |
| `/session/[id]/pay` | The guest's bank details, Monzo/Revolut links, *I've paid* |
| `/join`, `/join/[code]` | Join by code or link |
| `/history`, `/account` | Past bills, account |
| `/sign-in` | Email code sign-in |
| `/terms`, `/privacy`, `/refunds` | Legal pages |

## Code

- `app/globals.css` is the whole design system (Sky, #180): sky-blue header, cloud-white page with white cards, Anton headings over Plus Jakarta Sans (`next/font`), red-orange `--loud` only for each screen's main button, blue ink `--accent` for links, icons and selected states, black outline buttons, 56–64px tap targets.
- `components/ui.tsx` has the building blocks (Page, Title, Box, Row, Badge, Totals, Button, ActionBar, Dialog, …). Use them rather than new styles.
- `components/AppShell.tsx` is the header, menu and sign-in gate. `components/Scanner.tsx` is photo → check ("All in?") → upload → read; `components/Camera.tsx` is the in-app camera it opens.
- API calls and hooks come from `@gdp/core` ([packages/core](../../packages/core/README.md)).
- `lib/joinFragment.ts` puts the lead's bank details in the link's `#p=` fragment ([ADR-0002](../../docs/decisions.md#adr-0002-bank-details-stay-on-the-leads-device)).

## Settings

`.env.local`, see `.env.example`:

- `NEXT_PUBLIC_API_BASE_URL`: the API. `npm run dev:local` sets it to `http://localhost:3000`.
- `NEXT_PUBLIC_PUBLIC_BASE_URL`: the site's own URL for QR codes; defaults to the page origin.
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`: for the platform fee.

## Tests

```bash
npm run build -w apps/web && npm run e2e -w apps/web
```

- The Playwright suite in `e2e/` runs against `FakeApi` (`e2e/fakeApi.ts`), an in-memory API, with one browser context per diner.
- Guest totals are checked through `data-testid="your-share"`.
- Visual snapshots belong to CI (Linux Chromium). To refresh them, run the **Update visual baselines** workflow on your branch, download its artifact and commit the PNGs.
- The mobile WebKit project only runs in CI.
