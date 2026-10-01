// ---------------------------------------------------------------------------
// Human-like mouse movement — distributions from empirical trace
// (recordings/behavior_2026-04-18T19-26-02-154Z.jsonl):
//   pointer velocity: p50=0.76 px/ms, p25=0.12 (stalls), p75=1.85, p95=4.82
//   click-to-click gaps: rapid 187–213ms; deliberate 2961–10584ms
// ---------------------------------------------------------------------------

import { cubicBezier } from '../utils/motion/bezier.js';
import { randomBetween, waitMs, humanRandom } from '../utils/motion/timing.js';
import { traceAvailable, nextPointerStepMs, nextInterClickMs, getMoveTemplate } from './trace.js';
import { getOffsetFromPage, nativeClick, nativeBatchMove, nativeMove } from './mouse-native.js';
import { settledTargetBox } from './pointer/target-box.js';
import { pageSettled, type EvaluatingPage } from '../browser/settled.js';

export { nextInterClickMs };

export interface MousePage {
  mouse: {
    move(x: number, y: number): Promise<void>;
    click(x: number, y: number): Promise<void>;
  };
}

function sampleStepMs(): number {
  if (traceAvailable()) return nextPointerStepMs();
  const r = humanRandom();
  if (r < 0.25) return randomBetween(30, 120);
  if (r < 0.75) return randomBetween(10, 30);
  if (r < 0.95) return randomBetween(5, 12);
  return randomBetween(2, 6);
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
 * @param page          a page with wheel input and DOM evaluation
 * @param totalDeltaY   approximate cumulative pixels (positive down, negative up)
 * @param burstCount    how many distinct scroll bursts to break the total into
 */
export async function humanScroll(
  page: EvaluatingPage & { mouse: { wheel(dx: number, dy: number): Promise<void> } },
  totalDeltaY = 1200,
  burstCount = 3,
): Promise<void> {
  const perBurst = Math.max(120, Math.round(Math.abs(totalDeltaY) / burstCount));
  for (let b = 0; b < burstCount; b++) {
    const wheelsThisBurst = Math.floor(randomBetween(2, 5));
    let remaining = perBurst;
    for (let i = 0; i < wheelsThisBurst; i++) {
      // Each wheel event is 80-260 px (matches macOS magic-mouse / trackpad
      // intermediate scroll deltas; far from the unrealistic 1000+ that
      // page.evaluate(window.scrollBy(0, N)) would produce).
      const dy = Math.min(remaining, Math.floor(randomBetween(80, 260)));
      remaining -= dy;
      await page.mouse.wheel(0, Math.sign(totalDeltaY) * dy);
      await pageSettled(page);
      if (remaining <= 0) break;
    }
  }
}

// humanMove computes a Bezier or trace-replayed waypoint sequence, then
// dispatches every waypoint through nativeBatchMove (OS event queue, not CDP).
// CDP page.mouse.move events lack movementX/Y deltas and device timestamps
// that LinkedIn's /apfc/collect, Reddit's hovercard scoring, and TikTok's
// passport mssdk read for human-vs-bot classification.
// Input transport. DEFAULT = cdp: per-page Playwright mouse/keyboard
// (each WSession has its own browser context + CDP session), so
// concurrent loops never contend on a shared host OS cursor — the
// whole fleet is parallel-safe. WELES_INPUT=native opts a specific
// label back into cliclick/CGEventPost OS-queue events.
//
// The prior default was native, justified by a 2026-05-13 comment
// claiming CDP zeroed LinkedIn /apfc/collect hits. Operational
// history showed those LinkedIn/TikTok/Reddit/Discord failures were
// ultimately IP/proxy-caused, not input-transport-caused — that
// run's 8-vs-0 diff was confounded by the proxy difference. So
// there is no evidence-backed reason to keep native fleet-wide;
// native is now opt-in per label only where it is MEASURED to be
// required, not assumed. Both modes retain the path geometry; CDP advances
// through acknowledgements, while the native bridge owns its event delivery.
export function cdpInput(): boolean { return process.env.WELES_INPUT !== 'native'; }

async function emitPath(page: any, off: any, points: Array<{ x: number; y: number; dt?: number }>): Promise<void> {
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
  const template = traceAvailable() ? getMoveTemplate(sx, sy, x, y) : [];
  const points: Array<{ x: number; y: number; dt?: number }> = [];
  if (template.length) {
    for (const p of template) points.push({ x: p.x, y: p.y, dt: off ? Math.min(p.dt, 120) : undefined });
    points.push({ x, y, dt: 0 });
    // Route through emitPath so the CDP-vs-native dispatch branch
    // matches the Bezier branch at line 142 (which also uses emitPath).
    // The prior direct nativeBatchMove(off, points) caused a TS error
    // (off: NativeOffset | null vs NativeOffset) and a real runtime
    // bug: when cdpInput() is true and `off` is null, native dispatch
    // was attempted instead of the CDP page.mouse.move loop.
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
      dt: off ? sampleStepMs() : undefined,
    });
  }
  points.push({ x, y, dt: 0 });
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
