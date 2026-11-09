import { z } from 'zod';

/** Path and header parameters several routes share. Documentation only: the routes read them. */
export const params = {
  BillId: z.uuid(),
  SessionId: z.uuid(),
  PaymentId: z.uuid(),
  LinkToken: z.string().max(64).meta({ description: "The random token from a guest's text" }),
  IdempotencyKey: z
    .uuid()
    .meta({ description: 'Client-generated UUIDv7. Cached server-side for 24 hours.' }),
};

/** Error responses most routes can give, all in the one `ErrorResponse` envelope. */
export const sharedResponses = {
  BadRequest: 'Validation failure (`INVALID_INPUT`); `details` carries field errors',
  Unauthorized: 'Missing, invalid, or expired token',
  NotFound: 'Resource does not exist or caller cannot see it',
  IdempotencyConflict: 'Same key with a different request body',
  RateLimited: 'Too many requests',
} as const;

type Shared = keyof typeof sharedResponses;

/** A route's reference to one of the shared responses. */
export const responses = Object.fromEntries(
  Object.keys(sharedResponses).map((k) => [k, { $ref: `#/components/responses/${k}` }]),
) as { [K in Shared]: { $ref: string } };
