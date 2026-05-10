import 'hono';
import type { Logger } from '../logging/logger.js';

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string;
    logger: Logger;
    userId?: string;
    userEmail?: string;
    userName?: string;
    userPicture?: string;
  }
}
