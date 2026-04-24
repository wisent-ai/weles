/** Shared timing utilities — single source for randomBetween and waitMs. */

export function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run an async operation up to `attempts` times. On failure, wait a growing
 * delay and retry. Used by the register trajectories where the current
 * pattern is an inline `for (let attempt = 1; attempt <= MAX_RETRIES; ...)`
 * block duplicated across 6 files. Call signature matches the inline shape
 * so callers can drop in: `await retryWithBackoff((i) => signup(...), opts)`.
 * The callback receives the 1-indexed attempt number. On success, returns
 * the callback's return value. On exhaustion, rethrows the last error.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts?: { attempts?: number; baseDelaySec?: number; label?: string },
): Promise<T> {
  const attempts = opts?.attempts ?? 5;
  const base = opts?.baseDelaySec ?? 3;
  const label = opts?.label ?? 'retry';
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(`\n=== ${label} attempt ${i}/${attempts} ===`);
      return await fn(i);
    } catch (e: any) {
      lastErr = e;
      console.log(`FAIL (attempt ${i}): ${e.message?.slice(0, 200)}`);
      if (i === attempts) break;
      const delay = base * i;
      console.log(`Retrying in ${delay}s...`);
      await waitMs(delay * 1000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${label} exhausted after ${attempts} attempts`);
}
