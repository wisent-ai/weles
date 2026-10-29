// Pointer paths are recorded travel: every move replays a segment a person's
// hand made, harvested into the pointer trace (human/trace.ts), and every
// scroll replays recorded wheel steps. No geometry is written here, and no
// pause: the selected input transport owns delivery, and each step waits on
// the page settling as the page itself reports it.

import { humanRandom } from '../utils/motion/timing.js';
import { recordedApproach, recordedWheelStep, replayedPath } from './trace.js';
import type { Point } from './pointer/trace-file.js';
import {
  getOffsetFromPage,
  nativeClick,
  nativeBatchMove,
  nativeMove,
} from './mouse-native.js';
import { settledTargetBox } from './pointer/target-box.js';
import { pageSettled, type EvaluatingPage } from '../browser/settled.js';

export interface MousePage {
  mouse: {
    move(x: number, y: number): Promise<void>;
    click(x: number, y: number): Promise<void>;
  };
}

/** Where this run last left the pointer on each page. */
const lastPointer = new WeakMap<object, Point>();

/**
 * Vertical scroll in recorded wheel steps. Each acknowledged input is
 * followed by observed document/render readiness, not a timed pause. A failed
 * wheel operation ends the action with its actual error.
 *
 * The distance is the caller's: a pixel count it states (a keeper command, a
 * capture step), or one viewport through {@link humanScrollPage}.
 *
 * @param page          a page with wheel input and DOM evaluation
 * @param totalDeltaY   cumulative pixels (positive down, negative up)
 */
export async function humanScroll(
  page: EvaluatingPage & {
    mouse: { wheel(dx: number, dy: number): Promise<void> };
  },
  totalDeltaY: number,
): Promise<void> {
  if (!Number.isFinite(totalDeltaY)) {
    throw new Error(
      `humanScroll needs a finite pixel distance, got ${String(totalDeltaY)}`,
    );
  }
  let remaining = Math.abs(totalDeltaY);
  while (remaining > Number.MIN_VALUE) {
    const step = recordedWheelStep();
    const dy = Math.min(remaining, Math.abs(step.dy));
    remaining -= dy;
    await page.mouse.wheel(step.dx, Math.sign(totalDeltaY) * dy);
    await pageSettled(page);
  }
}

/**
 * Scroll one viewport down or up: the distance is the page's own observed
 * window height, so "read the next screen" means the same on every display.
 */
export async function humanScrollPage(
  page: EvaluatingPage & {
    mouse: { wheel(dx: number, dy: number): Promise<void> };
  },
  direction: 'down' | 'up',
): Promise<void> {
  const height = (await page.evaluate(() => window.innerHeight)) as number;
  if (!(height > Number.MIN_VALUE)) {
    throw new Error(
      `humanScrollPage read no viewport height from the page (window.innerHeight = ${String(height)})`,
    );
  }
  await humanScroll(page, direction === 'down' ? height : -height);
}

// The default CDP transport belongs to each page, so independent browser
// contexts do not share a host cursor. WELES_INPUT=native explicitly selects
// the global OS cursor through cliclick; the native bridge checks focus and
// command outcomes. Both transports preserve path geometry.
export function cdpInput(): boolean {
  return process.env.WELES_INPUT !== 'native';
}

async function emitPath(page: any, off: any, points: Point[]): Promise<void> {
  if (cdpInput()) {
    for (const p of points) {
      await page.mouse.move(p.x, p.y);
    }
    return;
  }
  // Non-CDP path: emit through the OS event queue (nativeBatchMove). `off`
  // is populated by callers when cdpInput() is false (humanMove,
  // humanClickLocator, humanClick); a caller that passes none is refused
  // rather than handing null to the native bridge.
  if (!off)
    throw new Error(
      'emitPath: native path requires NativeOffset; caller passed null',
    );
  await nativeBatchMove(off, points);
}

/**
 * Move the pointer to (x, y) along recorded travel. It starts where this run
 * last left it on the page, or at (startX, startY) when the caller knows
 * better; on a page this run has not moved over yet, the hand comes from where
 * a recorded segment came.
 */
export async function humanMove(
  page: any,
  x: number,
  y: number,
  startX?: number,
  startY?: number,
): Promise<void> {
  const off = cdpInput() ? null : await getOffsetFromPage(page);
  const to = { x, y };
  const stated =
    startX !== undefined && startY !== undefined
      ? { x: startX, y: startY }
      : undefined;
  const from = stated ?? lastPointer.get(page) ?? recordedApproach(to);
  await emitPath(page, off, [...replayedPath(from, to), to]);
  lastPointer.set(page, to);
}

/** A point inside `box`, drawn from the run's seeded timing source: where a hand lands on a target. */
function pointIn(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Point {
  return {
    x: box.x + box.width * humanRandom(),
    y: box.y + box.height * humanRandom(),
  };
}

async function press(page: any, point: Point): Promise<void> {
  if (cdpInput()) {
    await page.mouse.click(point.x, point.y);
    return;
  }
  const off = await getOffsetFromPage(page);
  nativeMove(off, point.x, point.y);
  await nativeClick(off, point.x, point.y);
}

/**
 * Locator-aware humanized click — the atom for "click this element".
 *
 * Resolves the settled bounding box, picks a point inside it, moves the
 * pointer there along recorded travel, then presses through the selected
 * transport.
 *
 * Throws when the bounding box can't be resolved — no degraded path.
 */
export async function humanClickLocator(
  page: any,
  locator: any,
): Promise<void> {
  const target = pointIn(await settledTargetBox(page, locator));
  await humanMove(page, target.x, target.y);
  await press(page, target);
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
  const target = pointIn(await settledTargetBox(page, locator));
  await humanMove(page, target.x, target.y);
  await pageSettled(page);
  if (opts.leave === false) return;
  const current = await locator.boundingBox();
  if (!current)
    throw new Error('humanHoverLocator: target detached before pointer leave');
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  // The hand leaves to the point mirrored through the viewport's centre,
  // which lies off the target unless the target spans it.
  const away = { x: viewport.width - target.x, y: viewport.height - target.y };
  if (
    away.x >= current.x &&
    away.x < current.x + current.width &&
    away.y >= current.y &&
    away.y < current.y + current.height
  ) {
    throw new Error(
      'humanHoverLocator: the target covers the viewport point the pointer would leave to; ' +
        `box x=${current.x} y=${current.y} w=${current.width} h=${current.height}` +
        ` viewport ${viewport.width}x${viewport.height}`,
    );
  }
  await humanMove(page, away.x, away.y);
  await pageSettled(page);
}

export async function humanClick(
  page: any,
  x: number,
  y: number,
  startX?: number,
  startY?: number,
): Promise<void> {
  await humanMove(page, x, y, startX, startY);
  await press(page, { x, y });
}

// Native cliclick-backed click/type helpers extracted to mouse-native.ts.
export type { NativeOffset } from './mouse-native.js';
export { getOffsetFromPage, nativeClick, nativeType } from './mouse-native.js';
