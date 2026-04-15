/** Shared timing utilities — single source for randomBetween and waitMs. */

export function randomBetween(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
