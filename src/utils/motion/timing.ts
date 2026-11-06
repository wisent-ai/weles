/** The run's human-timing draw: the seeded stream every pointer, typing and jitter choice draws from. */
import { createHash } from 'node:crypto';

// Every session seeds this at start (session/wsession/browser-launch.ts,
// recorded as result.run.timing_seed), so a run's draws are reproducible from
// that seed. A draw before any session seeded it is refused: drawing from an
// unseeded source would make the run unreproducible without saying so.
//
// The stream is SHA-256 over the seed and a counter, one digest per draw, in
// the manner of NIST SP 800-90A's Hash_DRBG: each draw is the digest's first
// 32-bit word.
let humanSeed: number | null = null;
let drawn = Number.MIN_SAFE_INTEGER;

/** The largest 32-bit word, read from a word whose every bit is set. */
const ALL_ONES = Buffer.alloc(
  Uint32Array.BYTES_PER_ELEMENT,
  'ff',
  'hex',
).readUInt32BE();

/** Set the per-run timing seed; the last call wins and the stream restarts. */
export function seedHumanTiming(seed: number): void {
  [humanSeed] = Uint32Array.of(seed);
  drawn = Number.MIN_SAFE_INTEGER;
}

/** The seed in effect for this run, or null before any session seeded it. */
export function getHumanTimingSeed(): number | null {
  return humanSeed;
}

/** The next 32-bit word of the run's stream. */
function nextWord(): number {
  if (humanSeed === null) {
    throw new Error(
      'human timing was drawn before any session seeded it (seedHumanTiming runs at session start); the run would not be reproducible from its recorded seed',
    );
  }
  drawn++;
  return createHash('sha256')
    .update(`${humanSeed}:${drawn}`)
    .digest()
    .readUInt32BE();
}

/** A uniform draw over [0, 1] from the run's seeded stream. */
export function humanRandom(): number {
  return nextWord() / ALL_ONES;
}

/** A uniform index below `count` from the run's seeded stream. */
export function humanIndex(count: number): number {
  if (!Number.isSafeInteger(count) || !(count > Number.MIN_VALUE))
    throw new Error(`humanIndex needs a whole count of choices, got ${count}`);
  return nextWord() % count;
}
