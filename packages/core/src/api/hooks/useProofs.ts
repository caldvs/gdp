import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type ApiError, type components } from '../index';

export type Proof = components['schemas']['Proof'];
type Slot = components['schemas']['ProofUploadSlot'];

/**
 * #226: proof-of-payment screenshots. The lead gets everyone's, a guest
 * their own. Signed URLs last 5 minutes, so this refetches every 4.
 */
export function useProofs(sessionId: string | undefined, opts: { enabled?: boolean; poll?: number } = {}) {
  return useQuery<Proof[], ApiError>({
    queryKey: ['proofs', sessionId],
    queryFn: async () => (await api<{ proofs: Proof[] }>(`/v1/sessions/${sessionId}/proofs`)).proofs,
    enabled: !!sessionId && opts.enabled !== false,
    refetchInterval: opts.poll ?? 240_000,
    staleTime: 0,
  });
}

/** Uploads one cropped JPEG (already re-encoded: no EXIF), then marks it sent. */
export function useSendProof(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<Proof, ApiError | Error, Blob>({
    mutationFn: async (jpeg) => {
      const slot = await api<Slot>(`/v1/sessions/${sessionId}/proofs`, {
        method: 'POST',
        body: { sizeBytes: jpeg.size },
      });
      // Straight to S3: no auth header, no JSON.
      const put = await fetch(slot.url, { method: 'PUT', headers: { 'content-type': 'image/jpeg' }, body: jpeg });
      if (!put.ok) throw new Error('The screenshot didn’t upload. Try again.');
      return api<Proof>(`/v1/sessions/${sessionId}/proofs/${slot.proofId}/sent`, { method: 'POST' });
    },
    onSuccess: (proof) => {
      qc.setQueryData<Proof[]>(['proofs', sessionId], (prev) => [...(prev ?? []).filter((p) => p.proofId !== proof.proofId), proof]);
    },
  });
}

export function useRemoveProof(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (proofId) => api<void>(`/v1/sessions/${sessionId}/proofs/${proofId}`, { method: 'DELETE' }),
    onSuccess: (_v, proofId) => {
      qc.setQueryData<Proof[]>(['proofs', sessionId], (prev) => (prev ?? []).filter((p) => p.proofId !== proofId));
    },
  });
}
