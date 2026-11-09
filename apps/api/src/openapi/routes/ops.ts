import { createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import { ErrorResponse } from '../schemas.js';

export const healthcheck = createRoute({
  method: 'get',
  path: '/healthz',
  operationId: 'healthcheck',
  summary: 'Liveness probe',
  tags: ['ops'],
  security: [],
  responses: {
    200: {
      description: 'Process is alive',
      content: {
        'application/json': {
          schema: z.object({
            status: z.literal('ok'),
          }),
        },
      },
    },
  },
});

export const readiness = createRoute({
  method: 'get',
  path: '/readyz',
  operationId: 'readiness',
  summary: 'Readiness probe (checks DDB and S3 connectivity)',
  tags: ['ops'],
  security: [],
  responses: {
    200: {
      description: 'Ready to serve traffic',
      content: {
        'application/json': {
          schema: z.object({
            status: z.literal('ok'),
            checks: z.object({
              ddb: z.enum(['ok', 'fail']).optional(),
              s3: z.enum(['ok', 'fail']).optional(),
            }),
          }),
        },
      },
    },
    503: {
      description: 'One or more dependencies are unhealthy',
      content: {
        'application/json': { schema: ErrorResponse },
      },
    },
  },
});
