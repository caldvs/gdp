import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  AWS_REGION: z.string().default('eu-west-2'),
  DYNAMODB_ENDPOINT: z.string().url().optional(),
  S3_ENDPOINT: z.string().url().optional(),
  DDB_TABLE_NAME: z.string().default('gdp-dev'),
  S3_BUCKET_BILLS: z.string().default('gdp-bills-raw-dev'),

  GOOGLE_CLIENT_ID: z.string().optional(),

  GEMINI_API_KEY: z.string().optional(),

  TRUELAYER_CLIENT_ID: z.string().optional(),
  TRUELAYER_CLIENT_SECRET: z.string().optional(),
  TRUELAYER_WEBHOOK_SECRET: z.string().optional(),
  TRUELAYER_ENVIRONMENT: z.enum(['sandbox', 'live']).default('sandbox'),

  PAYMENT_PROVIDER: z.enum(['mock', 'truelayer']).default('mock'),
});

export type Env = z.infer<typeof EnvSchema>;

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

export const env: Env = parsed.data;

export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isLocal = !!env.DYNAMODB_ENDPOINT;
