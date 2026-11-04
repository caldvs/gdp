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
    /** Set for a guest (#183): the one session they may use. */
    guestSessionId?: string;
  }
}
