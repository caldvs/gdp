import type { ContentfulStatusCode } from 'hono/utils/http-status';

export const ErrorCodes = {
  AUTH_MISSING: { http: 401 },
  AUTH_INVALID: { http: 401 },
  AUTH_EXPIRED: { http: 401 },
  INVALID_INPUT: { http: 400 },
  IDEMPOTENCY_CONFLICT: { http: 409 },
  NOT_FOUND: { http: 404 },
  BILL_NOT_FOUND: { http: 404 },
  SESSION_NOT_FOUND: { http: 404 },
  PAYMENT_NOT_FOUND: { http: 404 },
  SESSION_INVALID_STATE: { http: 409 },
  CLAIMS_INCOMPLETE: { http: 409 },
  CLAIMS_EXCEED_QUANTITY: { http: 409 },
  CLAIM_SHARE_CONFLICT: { http: 409 },
  ITEM_NOT_SHAREABLE: { http: 409 },
  SHARE_WAYS_TOO_LOW: { http: 409 },
  SHARE_PAID: { http: 409 },
  ALREADY_PAID_FOR: { http: 409 },
  SHARE_CONFLICT: { http: 409 },
  PARTICIPANTS_NOT_READY: { http: 409 },
  PAYOUT_ACCOUNT_REQUIRED: { http: 409 },
  TABLE_FEE_PAID: { http: 409 },
  TABLE_FEE_WAIVED: { http: 409 },
  PARSE_FAILED: { http: 422 },
  PARSE_LOW_CONFIDENCE: { http: 422 },
  PARSE_TIMEOUT: { http: 504 },
  RATE_LIMITED: { http: 429 },
  PAYMENT_PROVIDER_ERROR: { http: 502 },
  INTERNAL_ERROR: { http: 500 },
} as const satisfies Record<string, { http: ContentfulStatusCode }>;

export type ErrorCode = keyof typeof ErrorCodes;
