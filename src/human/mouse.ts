// Pointer paths use recorded geometry or Bezier waypoints. The selected input
// transport owns delivery; Weles does not add inter-waypoint pacing.

import { cubicBezier } from '../utils/motion/bezier.js';
import { randomBetween, waitMs, humanRandom } from '../utils/motion/timing.js';
import { getMoveTemplate } from './trace.js';
import { getOffsetFromPage, nativeClick, nativeBatchMove, nativeMove } from './mouse-native.js';
import { settledTargetBox } from './pointer/target-box.js';
import { pageSettled, type EvaluatingPage } from '../browser/settled.js';

export interface MousePage {
  mouse: {
    move(x: number, y: number): Promise<void>;
    click(x: number, y: number): Promise<void>;
  };
}


/**
 * The three named kinds are the reaction-shaped defaults. A `[min, max]` pair
 * is a dwell budget somebody declared — a declared observation carries its own
 * millisecond range, and passing it here is what makes that column real rather
 * than a number in a file nobody applied.
 */
export type IdlePause = 'short' | 'deliberate' | 'long' | readonly [number, number];

export async function humanIdlePause(kind: IdlePause = 'deliberate'): Promise<void> {
  const ms = typeof kind !== 'string' ? randomBetween(kind[0], kind[1])
    : kind === 'short' ? randomBetween(180, 400)
    : kind === 'long' ? randomBetween(5000, 11000)
    : randomBetween(2500, 5500);
  await waitMs(ms);
}

/**
 * Vertical scroll split into small wheel deltas. Each acknowledged input is
 * followed by observed document/render readiness, not a timed pause. A failed
 * wheel operation ends the action with its actual error.
 *
 * The distance is the caller's: a pixel count it states (a keeper command, a
 * capture step), or one viewport through {@link humanScrollPage}. Trajectories
 * used to type their own pixel counts and a burst count that changed nothing
 * once the pauses between bursts were gone.
 *
 * @param page          a page with wheel input and DOM evaluation
 * @param totalDeltaY   cumulative pixels (positive down, negative up)
 */
export async function humanScroll(
  page: EvaluatingPage & { mouse: { wheel(dx: number, dy: number): Promise<void> } },
  totalDeltaY: number,
): Promise<void> {
  if (!Number.isFinite(totalDeltaY)) {
    throw new Error(`humanScroll needs a finite pixel distance, got ${String(totalDeltaY)}`);
  }
  let remaining = Math.abs(totalDeltaY);
  while (remaining > Number.MIN_VALUE) {
      // Each wheel event is 80-260 px (matches macOS magic-mouse / trackpad
      // intermediate scroll deltas; far from the unrealistic 1000+ that
      // page.evaluate(window.scrollBy(0, N)) would produce).
      const dy = Math.min(remaining, Math.floor(randomBetween(80, 260)));
      remaining -= dy;
      await page.mouse.wheel(0, Math.sign(totalDeltaY) * dy);
      await pageSettled(page);
  }
}

/**
 * Scroll one viewport down or up: the distance is the page's own observed
 * window height, so "read the next screen" means the same on every display.
 */
export async function humanScrollPage(
  page: EvaluatingPage & { mouse: { wheel(dx: number, dy: number): Promise<void> } },
  direction: 'down' | 'up',
): Promise<void> {
  const height = await page.evaluate(() => window.innerHeight) as number;
  if (!(height > Number.MIN_VALUE)) {
    throw new Error(`humanScrollPage read no viewport height from the page (window.innerHeight = ${String(height)})`);
  }
  await humanScroll(page, direction === 'down' ? height : -height);
}

// The default CDP transport belongs to each page, so independent browser
// contexts do not share a host cursor. WELES_INPUT=native explicitly selects
// the global OS cursor through cliclick; the native bridge checks focus and
// command outcomes. Both transports preserve path geometry.
export function cdpInput(): boolean { return process.env.WELES_INPUT !== 'native'; }

async function emitPath(page: any, off: any, points: Array<{ x: number; y: number }>): Promise<void> {
  if (cdpInput()) {
    for (const p of points) {
      await page.mouse.move(p.x, p.y);
    }
    return;
  }
  // Non-CDP path: emit through the OS event queue. The recursive
  // `emitPath(page, off, points)` that was here is unreachable-by-design
  // (infinite self-call); the intended sink is nativeBatchMove. `off` is
  // populated by callers when cdpInput() is false (humanMove:116 etc.),
  // so it should be non-null here; assert and surface a loud error if a
  // caller violates that invariant rather than silently passing null
  // into the native bridge.
  if (!off) throw new Error('emitPath: native path requires NativeOffset; caller passed null');
  await nativeBatchMove(off, points);
}

export async function humanMove(page: any, x: number, y: number, startX?: number, startY?: number, steps?: number): Promise<void> {
  const off = cdpInput() ? null : await getOffsetFromPage(page);
  const sx = startX ?? randomBetween(200, 600);
  const sy = startY ?? randomBetween(150, 450);
  const points = getMoveTemplate(sx, sy, x, y);
  if (points.length) {
    points.push({ x, y });
    await emitPath(page, off, points);
    return;
  }
  const n = steps ?? Math.max(20, Math.floor(randomBetween(30, 60)));
  const dx = x - sx; const dy = y - sy;
  const cp1x = sx + dx * randomBetween(0.1, 0.4) + randomBetween(-80, 80);
  const cp1y = sy + dy * randomBetween(0.1, 0.4) + randomBetween(-80, 80);
  const cp2x = sx + dx * randomBetween(0.6, 0.9) + randomBetween(-60, 60);
  const cp2y = sy + dy * randomBetween(0.6, 0.9) + randomBetween(-60, 60);
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    points.push({
      x: Math.round(cubicBezier(sx, cp1x, cp2x, x, t)),
      y: Math.round(cubicBezier(sy, cp1y, cp2y, y, t)),
    });
  }
  points.push({ x, y });
  await emitPath(page, off, points);
}

/**
 * Locator-aware humanized click — the atom for "click this element".
 *
 * Resolves the bounding box, picks an in-element random offset, moves the
 * OS-level pointer along a Bezier path to that offset, then dispatches the
 * click through the OS event queue (nativeClick → CGEventPost). Movement
 * and click carry movementX/Y deltas + device timestamps required by
 * LinkedIn /apfc/collect, Reddit hovercard scoring, TikTok passport mssdk.
 *
 * Throws when the bounding box can't be resolved — no degraded path.
 */
export async function humanClickLocator(page: any, locator: any): Promise<void> {
  const box = await settledTargetBox(page, locator);
  const padX = Math.max(2, Math.floor(box.width * 0.15));
  const padY = Math.max(2, Math.floor(box.height * 0.15));
  const tx = box.x + padX + Math.floor(humanRandom() * Math.max(1, box.width - padX * 2));
  const ty = box.y + padY + Math.floor(humanRandom() * Math.max(1, box.height - padY * 2));
  await humanMove(page, tx, ty);
  const jx = Math.round(tx + randomBetween(-2, 2));
  const jy = Math.round(ty + randomBetween(-2, 2));
  if (cdpInput()) {
    await page.mouse.move(jx, jy);
    await page.mouse.click(jx, jy);
    return;
  }
  const off = await getOffsetFromPage(page);
  nativeMove(off, jx, jy);
  await nativeClick(off, jx, jy);
}

/**
 * Move over a real target and observe the rendered page, optionally leaving it
 * afterwards. This reports pointer input, not invented reading time or proof
 * that a site's delayed hovercard appeared. Such a result needs its own
 * observable condition in the trajectory.
 */
export async function humanHoverLocator(
  page: any,
  locator: any,
  opts: { leave?: boolean } = {},
): Promise<void> {
  const box = await settledTargetBox(page, locator);
  const tx = box.x + box.width * randomBetween(0.2, 0.8);
  const ty = box.y + box.height * randomBetween(0.2, 0.8);
  await humanMove(page, tx, ty);
  await pageSettled(page);
  if (opts.leave ?? true) {
    const current = await locator.boundingBox();
    if (!current) throw new Error('humanHoverLocator: target detached before pointer leave');
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    const ox = current.x > 0 ? 0 : Math.max(0, viewport.width - 1);
    const oy = current.y > 0 ? 0 : Math.max(0, viewport.height - 1);
    if (ox >= current.x && ox < current.x + current.width
      && oy >= current.y && oy < current.y + current.height) {
      throw new Error(
        'humanHoverLocator: no off-target viewport corner is available; '
        + `box x=${current.x} y=${current.y} w=${current.width} h=${current.height}`
        + ` viewport ${viewport.width}x${viewport.height}`,
      );
    }
    await humanMove(page, ox, oy);
    await pageSettled(page);
  }
}

export async function humanClick(page: any, x: number, y: number, startX?: number, startY?: number): Promise<void> {
  await humanMove(page, x, y, startX, startY);
  const jx = Math.round(x + randomBetween(-2, 2));
  const jy = Math.round(y + randomBetween(-2, 2));
  if (cdpInput()) {
    await page.mouse.move(jx, jy);
    await page.mouse.click(jx, jy);
    return;
  }
  const off = await getOffsetFromPage(page);
  nativeMove(off, jx, jy);
  await nativeClick(off, jx, jy);
}

// Native cliclick-backed click/type helpers extracted to mouse-native.ts.
export type { NativeOffset } from './mouse-native.js';
export { getOffsetFromPage, nativeClick, nativeType, getWindowOffset } from './mouse-native.js';
