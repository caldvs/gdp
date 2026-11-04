/**
 * TABLE_FEE_EXEMPT_EMAILS: people who never pay the table fee and sign in
 * with just their email, no code (decided 1 Nov 2026, risk accepted).
 * `"a@x.com, B@y.com"` → a set of lower-cased addresses.
 */
export const parseEmailList = (list: string): ReadonlySet<string> =>
  new Set(
    list
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.includes('@')),
  );
