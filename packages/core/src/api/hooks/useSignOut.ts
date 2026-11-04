import { useQueryClient } from '@tanstack/react-query';
import { clearToken, clearLastActive, getStoredToken } from '../auth';
import { api } from '../index';

/**
 * Sign out. With `everywhere` (the Sign out buttons), the server first ends
 * every session this account has, on every device (#155); a failure there
 * still signs this tab out. Without it (idle timeout), only this device.
 */
export function useSignOut() {
  const qc = useQueryClient();
  return async (opts: { everywhere?: boolean } = {}) => {
    if (opts.everywhere && (await getStoredToken())) {
      try {
        await api('/v1/me/sign-out', { method: 'POST' });
      } catch {
        /* signed out here anyway */
      }
    }
    await clearToken();
    clearLastActive();
    qc.clear();
  };
}
