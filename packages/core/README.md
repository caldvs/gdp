# `@gdp/core`

Client code shared by the web app: the typed API client, React Query hooks and the money maths. It's consumed as TypeScript source (`transpilePackages` in the web app's Next config), so there's no build step.

- `src/api/schema.d.ts` is generated from `apps/api/openapi.yaml` (itself generated from the API's Zod) by `npm run gen:api`. Don't edit it.
- `src/api/client.ts` and `src/api/hooks/` wrap every endpoint the web app uses.
- `src/lib/owed.ts` works out what a guest owes. It must match the API's `computeOwedForParticipant`; `sharePence` must match the API's `splitShare`.
- `src/lib/` also has the QR payload, quick-pay links (Monzo/Revolut), payout-account validation, image re-encoding and hashing, and idempotency keys.

```bash
npm test -w packages/core
```
