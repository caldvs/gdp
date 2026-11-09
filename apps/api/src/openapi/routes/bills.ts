import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { params, responses } from '../common.js';
import {
  ErrorResponse,
  Bill,
  UploadRequest,
  UploadSlot,
  UploadDuplicate,
  ParsedBill,
  ParseRequest,
  ForkBillRequest,
  BillRead,
  AmendBillRequest,
} from '../schemas.js';

export const requestBillUpload = createRoute({
  method: 'post',
  path: '/v1/bills/uploads',
  operationId: 'requestBillUpload',
  summary: 'Request a pre-signed S3 PUT URL for a bill image',
  description: `Two-step upload: client computes SHA-256 of the resized image bytes and calls this endpoint.
If the hash is already mapped to one of this user's bills, returns \`{ status: "duplicate", billId }\`
with where that bill stands (\`versionNumber\`, \`amended\`, \`session\`), and no S3 upload is needed. Otherwise returns a short-lived (5-minute) pre-signed PUT URL with
scoped permissions (specific key, content-length cap, PUT only).
`,
  tags: ['bills'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': { schema: UploadRequest },
      },
    },
  },
  responses: {
    200: {
      description: 'Upload slot or duplicate-bill resolution',
      content: {
        'application/json': {
          schema: z.discriminatedUnion('status', [UploadSlot, UploadDuplicate]),
        },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    429: responses.RateLimited,
  },
});

export const parseBill = createRoute({
  method: 'post',
  path: '/v1/bills/parse',
  operationId: 'parseBill',
  summary: 'Parse a previously uploaded image into a structured bill',
  description: `Synchronous call. Fetches the image from S3 (by \`uploadId\`), runs the configured \`BillParser\`
(Claude Sonnet on Amazon Bedrock), validates the parser output with zod, persists \`Bill\` v1, and indexes
the image hash. Has 22s, under API Gateway's 30s. The web app uses \`POST /v1/bills/reads\` instead.
Idempotent via \`Idempotency-Key\`.
`,
  tags: ['bills'],
  request: {
    headers: z.object({
      'Idempotency-Key': params.IdempotencyKey,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: ParseRequest },
      },
    },
  },
  responses: {
    200: {
      description:
        'Parsed bill. When the photo is one this user read before, their own latest version of that bill, with `duplicate` saying where it stands.',
      content: {
        'application/json': { schema: ParsedBill },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: {
      description: 'Upload not found or expired',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    409: responses.IdempotencyConflict,
    422: {
      description: 'Parser returned but output failed validation, or confidence below threshold',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    429: responses.RateLimited,
    502: {
      description: 'Upstream parser provider error',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    504: {
      description:
        'Reading the bill ran out of time (PARSE_TIMEOUT). The upload is kept, so the same uploadId can be parsed again.',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const startBillRead = createRoute({
  method: 'post',
  path: '/v1/bills/reads',
  operationId: 'startBillRead',
  summary: 'Start reading an uploaded image in the background',
  description: `Same read as \`POST /v1/bills/parse\`, but it runs in the background (with 45s rather than 22s)
and this returns at once. Poll \`GET /v1/bills/reads/{readId}\` until it's \`done\` (open \`billId\`)
or \`failed\` (the same error the synchronous parse would have returned). Idempotent via
\`Idempotency-Key\`.
`,
  tags: ['bills'],
  request: {
    headers: z.object({
      'Idempotency-Key': params.IdempotencyKey,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: ParseRequest },
      },
    },
  },
  responses: {
    202: {
      description: "Reading has started (or, if it couldn't be started, has already failed)",
      content: {
        'application/json': { schema: BillRead },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    409: responses.IdempotencyConflict,
  },
});

export const getBillRead = createRoute({
  method: 'get',
  path: '/v1/bills/reads/{readId}',
  operationId: 'getBillRead',
  summary: 'How a background read is going',
  description: `Only the user who started the read can see it. A read still \`reading\` after 90s is reported as
\`failed\` with \`PARSE_TIMEOUT\`. Reads are kept for a day.
`,
  tags: ['bills'],
  request: {
    params: z.object({
      readId: z.uuid(),
    }),
  },
  responses: {
    200: {
      description: 'The read',
      content: {
        'application/json': { schema: BillRead },
      },
    },
    401: responses.Unauthorized,
    404: {
      description: 'No such read for this user',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const getBill = createRoute({
  method: 'get',
  path: '/v1/bills/{billId}',
  operationId: 'getBill',
  summary: 'Get a bill (latest version unless ?version is specified)',
  tags: ['bills'],
  request: {
    params: z.object({
      billId: params.BillId,
    }),
    query: z.object({
      version: z
        .int()
        .min(1)
        .meta({ description: 'Specific version number; omit for latest' })
        .optional(),
    }),
  },
  responses: {
    200: {
      description: 'Bill record',
      content: {
        'application/json': { schema: Bill },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
  },
});

export const getBillImageUrl = createRoute({
  method: 'get',
  path: '/v1/bills/{billId}/image-url',
  operationId: 'getBillImageUrl',
  summary: 'Get a short-lived presigned GET URL for the original bill image',
  description: `Returns a presigned S3 GET URL (TTL ~5 min) for the original uploaded image. Available to the
bill creator and to any participant of a session this bill is pinned to. Returns 404 NOT_FOUND
for legacy bills that were parsed before the upload reference was retained.
`,
  tags: ['bills'],
  request: {
    params: z.object({
      billId: params.BillId,
    }),
  },
  responses: {
    200: {
      description: 'Presigned URL',
      content: {
        'application/json': {
          schema: z.object({
            url: z.url(),
            expiresAt: z.iso.datetime(),
          }),
        },
      },
    },
    401: responses.Unauthorized,
    404: responses.NotFound,
  },
});

export const amendBill = createRoute({
  method: 'post',
  path: '/v1/bills/{billId}/amend',
  operationId: 'amendBill',
  summary: 'Create a new version of the bill with user edits',
  description: `Allowed when the bill is either (a) not yet attached to a session, or (b) attached to a session
in \`setup\` or \`claiming\`. Once a session enters \`paying\`, the bill is frozen.

When an active session is attached, the amend reconciles in lockstep: the session's
\`pinnedBillVersion\` bumps to the new version, claims pointing to removed items are dropped, and
non-creator participants are un-readied so they re-confirm against the new bill. If the new
quantity for an item is below the count of claims already attached to it, the call fails with
\`409 CLAIMS_EXCEED_QUANTITY\` — the lead must clear those claims (or raise the quantity) first.
Item IDs are preserved where item identity is preserved.
`,
  tags: ['bills'],
  request: {
    params: z.object({
      billId: params.BillId,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: AmendBillRequest },
      },
    },
  },
  responses: {
    200: {
      description: 'New bill version',
      content: {
        'application/json': { schema: Bill },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: responses.NotFound,
    409: {
      description: `Bill is frozen (session in \`paying\` or \`settled\`), or the amend would orphan existing
claims (\`CLAIMS_EXCEED_QUANTITY\`).
`,
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});

export const forkBill = createRoute({
  method: 'post',
  path: '/v1/bills/{billId}/fork',
  operationId: 'forkBill',
  summary: 'Start again with a new bill for the same photo',
  description: `A new bill (new \`billId\`, version 1, new item ids) for this bill's photo, with
\`parsedFrom.forkedFrom\` naming the bill and version it came from. \`from: latest\` (the default)
copies the latest version, so the lead's corrections carry over. \`from: analysis\` makes it
from what the current parser read off the photo: the cached read when there is one, else a
new read, which counts against the daily read limit (429 \`RATE_LIMITED\`). The photo's hash
index moves to the new bill, so sending the photo again opens it. The old bill and its
sessions are untouched. Owner only: anyone else gets 404. Idempotent via \`Idempotency-Key\`.
`,
  tags: ['bills'],
  request: {
    params: z.object({
      billId: params.BillId,
    }),
    headers: z.object({
      'Idempotency-Key': params.IdempotencyKey,
    }),
    body: {
      required: true,
      content: {
        'application/json': { schema: ForkBillRequest },
      },
    },
  },
  responses: {
    201: {
      description: 'The new bill',
      content: {
        'application/json': { schema: Bill },
      },
    },
    400: responses.BadRequest,
    401: responses.Unauthorized,
    404: {
      description: 'Bill not found, or (`from: analysis`) its photo is no longer available',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    409: responses.IdempotencyConflict,
    422: {
      description: 'Reading the photo again failed (`from: analysis`)',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    429: responses.RateLimited,
    502: {
      description: 'Upstream parser provider error',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
    504: {
      description: 'Reading the photo again ran out of time (PARSE_TIMEOUT)',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});
