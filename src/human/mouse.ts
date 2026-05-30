// ---------------------------------------------------------------------------
// Human-like mouse movement — distributions from empirical trace
// (recordings/behavior_2026-04-18T19-26-02-154Z.jsonl):
//   pointer velocity: p50=0.76 px/ms, p25=0.12 (stalls), p75=1.85, p95=4.82
//   click-to-click gaps: rapid 187–213ms; deliberate 2961–10584ms
// ---------------------------------------------------------------------------

import { cubicBezier } from '../utils/bezier.js';
import { randomBetween, waitMs } from '../utils/timing.js';
import { traceAvailable, nextPointerStepMs, nextReactionMs, nextInterClickMs, getMoveTemplate } from './trace.js';
import { getOffsetFromPage, nativeClick, nativeBatchMove, nativeMove } from './mouse-native.js';

export { nextInterClickMs };

export interface MousePage {
  mouse: {
    move(x: number, y: number): Promise<void>;
    click(x: number, y: number): Promise<void>;
  };
}

function sampleStepMs(): number {
  if (traceAvailable()) return nextPointerStepMs();
  const r = Math.random();
  if (r < 0.25) return randomBetween(30, 120);
  if (r < 0.75) return randomBetween(10, 30);
  if (r < 0.95) return randomBetween(5, 12);
  return randomBetween(2, 6);
}

function sampleReactionMs(): number {
  if (traceAvailable()) return nextReactionMs();
  const r = Math.random();
  if (r < 0.20) return randomBetween(180, 230);
  if (r < 0.80) return randomBetween(100, 250);
  return randomBetween(250, 500);
}

export async function humanIdlePause(kind: 'short' | 'deliberate' | 'long' = 'deliberate'): Promise<void> {
  const ms = kind === 'short' ? randomBetween(180, 400)
    : kind === 'long' ? randomBetween(5000, 11000)
    : randomBetween(2500, 5500);
  await waitMs(ms);
}

/**
 * Human-like vertical scroll. Real users scroll in bursts of 2-5 wheel deltas
 * with sub-second pauses, then dwell on the new content for a few seconds
 * before the next burst. Use this BEFORE any write verb (comment, vote, like)
 * so the behavioral classifier sees realistic dwell + scroll signal, not a
 * goto -> immediate-action pattern. Reddit's async spam classifier reads
 * this telemetry as part of the post-comment scoring window.
 *
 * @param page          a Playwright Page (with .mouse.wheel + .waitForTimeout)
 * @param totalDeltaY   approx total cumulative pixels to scroll (positive = down)
 * @param burstCount    how many distinct scroll bursts to break the total into
 */
export async function humanScroll(
  page: { mouse: { wheel(dx: number, dy: number): Promise<void> }; waitForTimeout(ms: number): Promise<void> },
  totalDeltaY = 1200,
  burstCount = 3,
): Promise<void> {
  const perBurst = Math.max(120, Math.round(totalDeltaY / burstCount));
  for (let b = 0; b < burstCount; b++) {
    const wheelsThisBurst = Math.floor(randomBetween(2, 5));
    let remaining = perBurst;
    for (let i = 0; i < wheelsThisBurst; i++) {
      // Each wheel event is 80-260 px (matches macOS magic-mouse / trackpad
      // intermediate scroll deltas; far from the unrealistic 1000+ that
      // page.evaluate(window.scrollBy(0, N)) would produce).
      const dy = Math.min(remaining, Math.floor(randomBetween(80, 260)));
      remaining -= dy;
      await page.mouse.wheel(0, dy).catch(() => {});
      await page.waitForTimeout(Math.floor(randomBetween(120, 380)));  // allow-raw-playwright: implementation file — defines the humanized atom
      if (remaining <= 0) break;
    }
    // Dwell between bursts — read the just-revealed content. 1.2-3.5s.
    await page.waitForTimeout(Math.floor(randomBetween(1200, 3500)));  // allow-raw-playwright: implementation file — defines the humanized atom
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
// required, not assumed. Bezier path + empirical timing identical
// in both modes; only the dispatch transport differs.
export function cdpInput(): boolean { return process.env.WELES_INPUT !== 'native'; }

async function emitPath(page: any, off: any, points: Array<{ x: number; y: number; dt?: number }>): Promise<void> {
  if (cdpInput()) {
    for (const p of points) {
      await page.mouse.move(p.x, p.y);
      if (p.dt && p.dt > 0) await waitMs(Math.min(p.dt, 120));
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
    for (const p of template) points.push({ x: p.x, y: p.y, dt: Math.min(p.dt, 120) });
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
      dt: sampleStepMs(),
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
  try { await locator.scrollIntoViewIfNeeded?.(); } catch { /* element may already be in view */ }
  const box = await locator.boundingBox?.();
  if (!box) throw new Error('humanClickLocator: bounding box unavailable (element detached or off-screen)');
  const padX = Math.max(2, Math.floor(box.width * 0.15));
  const padY = Math.max(2, Math.floor(box.height * 0.15));
  const tx = box.x + padX + Math.floor(Math.random() * Math.max(1, box.width - padX * 2));
  const ty = box.y + padY + Math.floor(Math.random() * Math.max(1, box.height - padY * 2));
  await humanMove(page, tx, ty);
  const jx = Math.round(tx + randomBetween(-2, 2));
  const jy = Math.round(ty + randomBetween(-2, 2));
  if (cdpInput()) {
    await page.mouse.move(jx, jy);
    await waitMs(sampleReactionMs());
    await page.mouse.click(jx, jy);
    return;
  }
  const off = await getOffsetFromPage(page);
  nativeMove(off, jx, jy);
  await waitMs(sampleReactionMs());
  await nativeClick(off, jx, jy);
}

/**
 * Locator-aware humanized hover dwell — the atom for "look at this element
 * like a human reading it". Moves the mouse via humanMove to inside the
 * element's bounding box, dwells long enough to trigger any onhover UI
 * (Reddit hovercard, tooltip, etc.), then optionally moves off + dwells so
 * the corresponding after-hide / mouseleave event also fires.
 *
 * Why this is its own atom:
 *   Reddit's anti-spam scoring reads `rpl-hovercard:after-show` /
 *   `rpl-hovercard:after-hide` as evidence the user inspected a username
 *   before commenting (verified 2026-05-01 via human-handoff vs trajectory
 *   property-trap diff: only-in-A subscribers included rpl-hovercard:*).
 *   Bots that nav -> click -> type -> submit never trigger the ~600ms
 *   hovercard delay; flagging them post-submit is reliable.
 *
 *   This same pattern is duplicated in scripts/trajectories/reddit/
 *   organic_comment.mjs (raw page.mouse.move + humanIdlePause). One atom,
 *   one place to tune timings.
 *
 * Fail-quiet: if the locator doesn't resolve, isn't visible, or is outside
 * the viewport, returns false without throwing — caller can ignore. Returns
 * true when the dwell actually executed.
 *
 * @param page         Playwright Page
 * @param locator      Playwright Locator (e.g. page.locator('a[href^="/user/"]').first())
 * @param opts.minMs   minimum dwell on the element (default 1500)
 * @param opts.maxMs   maximum dwell on the element (default 3300)
 * @param opts.leave   move off afterwards so mouseleave/after-hide fires (default true)
 */
export async function humanHoverDwell(
  page: any,
  locator: any,
  opts: { minMs?: number; maxMs?: number; leave?: boolean } = {},
): Promise<boolean> {
  const minMs = opts.minMs ?? 1500;
  const maxMs = opts.maxMs ?? 3300;
  const leave = opts.leave ?? true;
  try {
    if ((await locator.count?.()) === 0) return false;
  } catch { return false; }
  let box: { x: number; y: number; width: number; height: number } | null = null;
  try { box = await locator.boundingBox?.(); } catch { return false; }
  if (!box || box.width < 4 || box.height < 4) return false;
  // Skip if outside the viewport — humanMove to a negative or off-screen Y
  // silently kills the CDP session on weles-patched Chromium (verified
  // 2026-04-30 on the comment composer flow).
  let viewportH = 800;
  try { viewportH = await page.evaluate(() => window.innerHeight); } catch { /* keep heuristic 800 */ }
  if (box.y < 0 || box.y + box.height > viewportH) {
    try { await locator.scrollIntoViewIfNeeded?.(); } catch { /* may already be near top */ }
    let reBox: { x: number; y: number; width: number; height: number } | null = null;
    try { reBox = await locator.boundingBox?.(); } catch { return false; }
    if (!reBox || reBox.y < 0 || reBox.y + reBox.height > viewportH) return false;
    box = reBox;
  }
  const padX = Math.max(2, Math.floor(box.width * 0.2));
  const padY = Math.max(2, Math.floor(box.height * 0.2));
  const tx = box.x + padX + Math.floor(Math.random() * Math.max(1, box.width - padX * 2));
  const ty = box.y + padY + Math.floor(Math.random() * Math.max(1, box.height - padY * 2));
  await humanMove(page, tx, ty);
  await waitMs(randomBetween(minMs, maxMs));
  if (leave) {
    // Move off the element by ~80–160px in a random direction so mouseleave /
    // rpl-hovercard:after-hide fires. Stay in-viewport.
    const dx = (Math.random() < 0.5 ? -1 : 1) * randomBetween(80, 160);
    const dy = randomBetween(40, 120);
    const ox = Math.max(20, Math.min(tx + dx, viewportH > 0 ? 9999 : tx + dx));
    const oy = Math.max(20, Math.min(ty + dy, viewportH - 20));
    await humanMove(page, ox, oy);
    await waitMs(randomBetween(600, 1300));
  }
  return true;
}

export async function humanClick(page: any, x: number, y: number, startX?: number, startY?: number): Promise<void> {
  await humanMove(page, x, y, startX, startY);
  const jx = Math.round(x + randomBetween(-2, 2));
  const jy = Math.round(y + randomBetween(-2, 2));
  if (cdpInput()) {
    await page.mouse.move(jx, jy);
    await waitMs(sampleReactionMs());
    await page.mouse.click(jx, jy);
    return;
  }
  const off = await getOffsetFromPage(page);
  nativeMove(off, jx, jy);
  await waitMs(sampleReactionMs());
  await nativeClick(off, jx, jy);
}

// Native cliclick-backed click/type helpers extracted to mouse-native.ts.
export type { NativeOffset } from './mouse-native.js';
export { getOffsetFromPage, nativeClick, nativeType, getWindowOffset } from './mouse-native.js';
