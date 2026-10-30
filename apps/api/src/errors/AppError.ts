import { ErrorCodes, type ErrorCode } from './codes.js';

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly http: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.http = ErrorCodes[code].http;
    this.details = details;
  }
}
