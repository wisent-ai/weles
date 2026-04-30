// ---------------------------------------------------------------------------
// Human-like mouse movement — distributions from empirical trace
// (recordings/behavior_2026-04-18T19-26-02-154Z.jsonl):
//   pointer velocity: p50=0.76 px/ms, p25=0.12 (stalls), p75=1.85, p95=4.82
//   click-to-click gaps: rapid 187–213ms; deliberate 2961–10584ms
// ---------------------------------------------------------------------------

import { cubicBezier } from '../utils/bezier.js';
import { randomBetween, waitMs } from '../utils/timing.js';
import { traceAvailable, nextPointerStepMs, nextReactionMs, nextInterClickMs, getMoveTemplate } from './trace.js';

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
      await page.waitForTimeout(Math.floor(randomBetween(120, 380)));
      if (remaining <= 0) break;
    }
    // Dwell between bursts — read the just-revealed content. 1.2-3.5s.
    await page.waitForTimeout(Math.floor(randomBetween(1200, 3500)));
  }
}

export async function humanMove(page: MousePage, x: number, y: number, startX?: number, startY?: number, steps?: number): Promise<void> {
  const sx = startX ?? randomBetween(200, 600);
  const sy = startY ?? randomBetween(150, 450);
  // Prefer a real pointer-segment template from the operator trace, denormalized
  // A→B, each waypoint spatially jittered. Falls through to the Bezier generator
  // when no trace segments are available.
  const template = traceAvailable() ? getMoveTemplate(sx, sy, x, y) : [];
  if (template.length) {
    for (const p of template) {
      await page.mouse.move(p.x, p.y);
      await waitMs(Math.min(p.dt, 120));
    }
    await page.mouse.move(x, y);
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
    await page.mouse.move(Math.round(cubicBezier(sx, cp1x, cp2x, x, t)), Math.round(cubicBezier(sy, cp1y, cp2y, y, t)));
    await waitMs(sampleStepMs());
  }
  await page.mouse.move(x, y);
}

/**
 * Locator-aware humanized click — the atom for "click this element".
 *
 * Resolves the element's bounding box, picks a small random offset inside it
 * (humans don't always click dead-center), then dispatches a real Bezier-pathed
 * mouse move to that position. After the human-like pointer movement completes,
 * delegates to the locator's `.click({ force: true })` for the actual click
 * event — this triggers React's synthetic event system (form submit handlers,
 * onClick delegates, etc). force:true skips Playwright's actionability checks
 * (visible/enabled/stable) which would timeout on disabled buttons or obscured
 * elements. A raw `page.mouse.click()` at the same coordinates often fails to
 * fire React's form onSubmit because the event doesn't propagate through
 * React's event delegation root — verified 2026-04-30 on TikTok's login
 * form: `page.mouse.click` on the submit button never fired the
 * `/passport/web/login/` POST, while `locator.click({force:true})` did.
 *
 * Falls back gracefully to the locator's native .click() if the bbox is
 * unavailable (e.g. element off-screen / detached).
 *
 * Use this anywhere a trajectory needs to click an element. Do NOT call
 * `locator.click()` directly (skips humanMove pre-trajectory) and do NOT
 * call `page.evaluate(() => el.click())` (synthetic click, no mouse events
 * reach the page — Reddit/Twitter/Instagram behavioral trackers flag
 * accounts whose action click has no preceding pointer activity, which
 * triggers post-action shadowbans even when the static fingerprint is clean).
 */
export async function humanClickLocator(page: any, locator: any): Promise<void> {
  await locator.scrollIntoViewIfNeeded?.().catch(() => {});
  const box = await locator.boundingBox?.().catch(() => null);
  if (!box) {
    await locator.click();
    return;
  }
  const padX = Math.max(2, Math.floor(box.width * 0.15));
  const padY = Math.max(2, Math.floor(box.height * 0.15));
  const tx = box.x + padX + Math.floor(Math.random() * Math.max(1, box.width - padX * 2));
  const ty = box.y + padY + Math.floor(Math.random() * Math.max(1, box.height - padY * 2));
  // Human-like pointer movement — behavioral trackers see the mouse travel
  // to the target before the click fires. This is the anti-shadowban part.
  await humanMove(page as MousePage, tx, ty);
  const jx = tx + randomBetween(-2, 2);
  const jy = ty + randomBetween(-2, 2);
  await page.mouse.move(Math.round(jx), Math.round(jy));
  await waitMs(sampleReactionMs());
  // Delegate the actual click to the locator with force:true — Playwright's
  // locator.click() triggers React's synthetic event system correctly (form
  // onSubmit, onClick delegates, etc), whereas page.mouse.click() dispatches
  // a raw DOM MouseEvent that React's event delegation may not pick up.
  // force:true skips Playwright's actionability checks (visible, enabled,
  // stable) which would otherwise timeout on disabled buttons or obscured
  // elements — the humanMove above already positioned the pointer at the
  // target, so we know the coordinates are correct. Verified 2026-04-30:
  // page.mouse.click on TikTok's login submit button never fired the
  // /passport/web/login/ POST; locator.click({force:true}) does.
  await locator.click({ force: true });
}

export async function humanClick(page: MousePage, x: number, y: number, startX?: number, startY?: number): Promise<void> {
  try {
    await humanMove(page, x, y, startX, startY);
    const jx = x + randomBetween(-2, 2);
    const jy = y + randomBetween(-2, 2);
    await page.mouse.move(Math.round(jx), Math.round(jy));
    await waitMs(sampleReactionMs());
    await page.mouse.click(Math.round(jx), Math.round(jy));
  } catch (e: any) {
    // Some sites (Reddit signup with js_ch) install a dispatchMouseEvent shim
    // that calls window.synthesizeMouseEvent — not exposed by the weles-patched
    // Chromium binary. Try nativeClick (cliclick → CGEventPost, isTrusted=true)
    // first; fall back to JS dispatchEvent (isTrusted=false) only if cliclick
    // isn't installed or the OS-level click doesn't go through.
    if (!/synthesizeMouseEvent|dispatchMouseEvent/i.test(e?.message ?? '')) throw e;
    try {
      const off = await getOffsetFromPage(page);
      await nativeClick(off, x, y);
      return;
    } catch { /* fall through to JS dispatchEvent */ }
    await (page as any).evaluate?.(`(({x,y})=>{var el=document.elementFromPoint(x,y);if(!el)return;['mousedown','mouseup','click'].forEach(t=>el.dispatchEvent(new MouseEvent(t,{bubbles:true,cancelable:true,clientX:x,clientY:y})))})(${JSON.stringify({x,y})})`);
  }
}

// Native macOS event emission via cliclick (CGEventPost-backed). CDP events
// have isTrusted=true but differ from OS-queue events in shape (movementX/Y
// deltas, device timestamps, subpixel coords); cliclick goes through the
// actual system event queue. Requires cliclick installed + browser window
// position via AppleScript for CSS-to-screen coord translation.
import { execSync, spawnSync } from 'node:child_process';

export interface NativeOffset { winX: number; winY: number; chromeY: number; }

// Get the browser window's screen position + chrome (title+url+tabs) height
// by evaluating window.screenX/Y/outerHeight/innerHeight in the page. This
// works even without Accessibility permission and without `--window-position`.
export async function getOffsetFromPage(page: any): Promise<NativeOffset> {
  try {
    const r = await page.evaluate(`(() => ({ sX: window.screenX, sY: window.screenY, iH: window.innerHeight, oH: window.outerHeight }))()`);
    if (!r) return { winX: 0, winY: 0, chromeY: 80 };
    // outerHeight-innerHeight is the ACCURATE chrome height, but Playwright
    // launchPersistentContext sometimes ends up with outer==inner on macOS
    // (reports content height as outer). Clamp to measured empirical 80px
    // when the computed value is implausibly small.
    const computed = (r.oH || 0) - (r.iH || 0);
    // Empirical 89px on macOS Chromium — outerHeight-innerHeight returns 80
     // but captured clientY is 9px off, consistent with chrome=89.
    const chromeY = 89;
    void computed;
    return { winX: r.sX || 0, winY: r.sY || 0, chromeY };
  } catch { return { winX: 0, winY: 0, chromeY: 85 }; }
}

export async function nativeClick(offset: NativeOffset, cssX: number, cssY: number): Promise<void> {
  const sx = Math.round(offset.winX + cssX + randomBetween(-1, 1));
  const sy = Math.round(offset.winY + offset.chromeY + cssY + randomBetween(-1, 1));
  // Skip the Bezier approach + reaction pause — those gave the page 100-500ms
  // to re-render and shift the button out from under the target coord.
  // Direct click at computed position minimizes the probe-to-click window.
  try {
    spawnSync('cliclick', [`m:${sx},${sy}`, `c:${sx},${sy}`], { stdio: 'ignore' });
  } catch { /* cliclick missing — caller should fall back */ }
}

export async function nativeType(text: string): Promise<void> {
  for (const ch of text) {
    try { spawnSync('cliclick', [`t:${ch}`], { stdio: 'ignore' }); } catch {}
    await waitMs(randomBetween(80, 220));
  }
}

export function getWindowOffset(processName = 'Chromium'): NativeOffset {
  // Default: assume --window-position=0,0 in CHROMIUM_ARGS (browser pinned
  // to screen top-left). macOS menu bar is 25px tall; Chromium title+url+tabs
  // add ~85px. Total chromeY = 85. Override via env if unavailable.
  const envX = parseInt(process.env.WELES_WIN_X ?? '0', 10);
  const envY = parseInt(process.env.WELES_WIN_Y ?? '0', 10);
  const envC = parseInt(process.env.WELES_CHROME_Y ?? '85', 10);
  // If Accessibility permission is granted (uncommon for terminal/node), use
  // AppleScript for precise coords. Otherwise use the pinned-position default.
  try {
    const pos = execSync(
      `osascript -e 'tell application "System Events" to tell process "${processName}" to get position of window 1' 2>/dev/null`,
      { encoding: 'utf8' },
    ).trim();
    const [winX, winY] = pos.split(',').map((s) => parseInt(s.trim(), 10));
    if (!isNaN(winX) && !isNaN(winY)) return { winX, winY, chromeY: envC };
  } catch {}
  return { winX: envX, winY: envY, chromeY: envC };
}
