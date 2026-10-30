/**
 * Vitest setup file for the integration project: wraps every app that
 * `createApp` builds so each `app.request` response is checked against
 * openapi.yaml (see contract.ts). A mismatch fails the test that made it.
 */
import { vi } from 'vitest';
import { checkResponse } from './contract.js';
import type * as AppModule from '../../src/app.js';

vi.mock('../../src/app.js', async (importOriginal) => {
  const mod = await importOriginal<typeof AppModule>();
  return {
    ...mod,
    createApp: (...args: Parameters<typeof mod.createApp>) => {
      const app = mod.createApp(...args);
      const request = app.request.bind(app);
      app.request = async (
        input: string | Request | URL,
        init?: RequestInit,
        ...rest: unknown[]
      ) => {
        const res = await (request as (...a: unknown[]) => Response | Promise<Response>)(
          input,
          init,
          ...rest,
        );
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const violation = await checkResponse(method, url, res);
        if (violation) throw new Error(`Contract: ${violation}`);
        return res;
      };
      return app;
    },
  };
});
