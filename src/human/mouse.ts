// ---------------------------------------------------------------------------
// Human-like mouse movement using Bezier curves
// ---------------------------------------------------------------------------

import { cubicBezier } from '../utils/bezier.js';
import { randomBetween, waitMs } from '../utils/timing.js';

export interface MousePage {
  mouse: {
    move(x: number, y: number): Promise<void>;
    click(x: number, y: number): Promise<void>;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Move the mouse along a Bezier curve from (`startX`, `startY`) to (`x`, `y`)
 * with random control points and human-like timing jitter.
 *
 * If `startX` / `startY` are omitted, a random origin near the center of a
 * typical viewport is chosen.
 */
export async function humanMove(
  page: MousePage,
  x: number,
  y: number,
  startX?: number,
  startY?: number,
  steps?: number,
): Promise<void> {
  const sx = startX ?? randomBetween(200, 600);
  const sy = startY ?? randomBetween(150, 450);
  const n = steps ?? Math.max(15, Math.floor(randomBetween(20, 45)));

  // Random control points — offset from the straight line to give a curve
  const dx = x - sx;
  const dy = y - sy;
  const cp1x = sx + dx * randomBetween(0.1, 0.4) + randomBetween(-80, 80);
  const cp1y = sy + dy * randomBetween(0.1, 0.4) + randomBetween(-80, 80);
  const cp2x = sx + dx * randomBetween(0.6, 0.9) + randomBetween(-60, 60);
  const cp2y = sy + dy * randomBetween(0.6, 0.9) + randomBetween(-60, 60);

  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const mx = cubicBezier(sx, cp1x, cp2x, x, t);
    const my = cubicBezier(sy, cp1y, cp2y, y, t);
    await page.mouse.move(Math.round(mx), Math.round(my));
    // Variable timing — faster in the middle, slower at start / end
    const basePause = 4 + 12 * (1 - 4 * (t - 0.5) * (t - 0.5));
    await waitMs(basePause + randomBetween(0, 6));
  }

  // Final exact position
  await page.mouse.move(x, y);
}

/**
 * Move the mouse in a human-like arc to (`x`, `y`), add a small jitter,
 * then click.
 */
export async function humanClick(
  page: MousePage,
  x: number,
  y: number,
  startX?: number,
  startY?: number,
): Promise<void> {
  await humanMove(page, x, y, startX, startY);

  // Small jitter around the target — humans don't click the exact pixel
  const jx = x + randomBetween(-2, 2);
  const jy = y + randomBetween(-2, 2);
  await page.mouse.move(Math.round(jx), Math.round(jy));

  // Brief pause before the click (reaction time)
  await waitMs(randomBetween(40, 150));

  await page.mouse.click(Math.round(jx), Math.round(jy));
}
