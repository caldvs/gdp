import type { PaymentStatus } from '../../types/payments.js';

export type WebhookEventType = 'authorized' | 'executed' | 'settled' | 'failed' | 'refunded';

/**
 * Pure state-transition function.
 * Returns the next status, or null if the transition is invalid (which means
 * the webhook should be acknowledged but the state should not change —
 * webhooks may arrive out of order or be replayed).
 */
export function nextStatus(current: PaymentStatus, event: WebhookEventType): PaymentStatus | null {
  if (current === 'pending' && event === 'authorized') return 'authorized';
  if (current === 'pending' && event === 'failed') return 'failed';
  if (current === 'authorized' && (event === 'executed' || event === 'settled')) {
    return 'succeeded';
  }
  if (current === 'authorized' && event === 'failed') return 'failed';
  if (current === 'succeeded' && event === 'refunded') return 'refunded';
  return null;
}

/**
 * For webhook idempotency: a transition is "already seen" when the new
 * status equals the current. The webhook is then a no-op acknowledgement.
 */
export function isAlreadyApplied(current: PaymentStatus, event: WebhookEventType): boolean {
  if (current === 'authorized' && event === 'authorized') return true;
  if (current === 'succeeded' && (event === 'executed' || event === 'settled')) return true;
  if (current === 'failed' && event === 'failed') return true;
  if (current === 'refunded' && event === 'refunded') return true;
  return false;
}
