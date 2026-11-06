import { z } from 'zod';

/** #226: a guest's cropped screenshot of their payment, JPEG only, re-encoded in the browser. */
export const PROOF_MAX_BYTES = 2 * 1024 * 1024;
export const PROOFS_PER_GUEST = 3;

export const StartProofRequestSchema = z.object({
  sizeBytes: z.number().int().positive().max(PROOF_MAX_BYTES),
});

export interface ProofRow {
  proofId: string;
  userId: string;
  createdAt: string;
  /** Set once the upload is confirmed. */
  sentAt?: string;
}

export interface ProofView {
  proofId: string;
  userId: string;
  sentAt: string;
  /** Short-lived signed GET. */
  url: string;
}
