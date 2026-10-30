// NEXT_PUBLIC_DEMO_MODE turns on the demo guardrails so we can host
// the app publicly without taking on the compliance burden of real
// PII collection:
//   - a persistent banner reminds users it's a demo
//   - /payout-account replaces the bank-detail inputs with safe fake
//     values and disables editing
//   - the web HTML emits a robots:noindex meta so the demo doesn't
//     show up in search
// EXPO_PUBLIC_* vars are inlined at build time — set the var before
// running `next build` or `next dev`.
export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';

// Pre-filled bank details shown on /payout-account when DEMO_MODE is
// on. These are the same dummy NatWest test values used throughout the
// fixtures — public Modulus-check passing but pointing at no real
// account. We use them rather than nonsense digits so the QR-encode
// path produces realistic-looking output for screenshots.
export const DEMO_PAYOUT = {
  sortCode: '040668',
  accountNumber: '00079660',
  accountHolderName: 'Demo User',
} as const;
