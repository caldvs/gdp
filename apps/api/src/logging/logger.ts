import pino from 'pino';
import { env } from '../config/env.js';

export const baseLogger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'gdp-backend', env: env.APP_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'req.headers["tl-signature"]',
      'res.headers["set-cookie"]',
      '*.password',
      '*.apiKey',
      '*.clientSecret',
      '*.secret',
      '*.token',
      '*.idToken',
      '*.refreshToken',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export type Logger = pino.Logger;
