/** True when a conditional write (or one step of a transaction) lost a race. */
export function isConditionalCheckFailed(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (e.name === 'ConditionalCheckFailedException') return true;
  if (e.name === 'TransactionCanceledException') {
    return Boolean(e.CancellationReasons?.some((r) => r.Code === 'ConditionalCheckFailed'));
  }
  return false;
}

/**
 * Run a read-modify-write, and if its conditional write lost a race, back
 * off a moment and run it again from the read. `giveUp` is thrown after
 * `retries` more tries.
 */
export async function retryOnConflict<T>(
  fn: () => Promise<T>,
  giveUp: () => Error,
  retries = 8,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      if (attempt >= retries) throw giveUp();
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20 * (attempt + 1)));
    }
  }
}
