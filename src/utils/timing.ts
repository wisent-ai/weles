/** Shared timing utilities — single source for randomBetween and waitMs. */

// G9: per-run human-timing RNG. When a seed is set (once, at session start via
// seedHumanTiming) the human-timing/mouse/typing jitter draws route through a
// deterministic mulberry32 PRNG so a run's timing is reproducible from the
// recorded seed. When NO seed is set, humanRandom falls back to Math.random and
// behavior is byte-for-byte identical to before this change — seeding is opt-in
// and never alters timing unless a seed has been wired. mulberry32 is a uniform
// [0,1) generator, statistically equivalent to Math.random for this use.
let _humanRng: (() => number) | null = null;
let _humanSeed: number | null = null;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Set the per-run timing seed. Idempotent-ish: last call wins. */
export function seedHumanTiming(seed: number): void {
  _humanSeed = seed >>> 0;
  _humanRng = mulberry32(_humanSeed);
}

/** The seed in effect for this run, or null if unseeded (Math.random fallback). */
export function getHumanTimingSeed(): number | null {
  return _humanSeed;
}

/**
 * Uniform [0,1) draw for human-timing jitter. Uses the seeded PRNG when a seed
 * has been set, else Math.random (unchanged legacy behavior). All human-timing
 * randomness SHOULD route through this so a run is reproducible from its seed.
 */
export function humanRandom(): number {
  return _humanRng ? _humanRng() : Math.random();
}

export function randomBetween(min: number, max: number): number {
  return min + humanRandom() * (max - min);
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
