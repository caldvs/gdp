import { useQueryClient } from '@tanstack/react-query';
import { clearToken, clearLastActive } from '../auth';

export function useSignOut() {
  const qc = useQueryClient();
  return async () => {
    await clearToken();
    clearLastActive();
    qc.clear();
  };
}
