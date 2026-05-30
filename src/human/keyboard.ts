// ---------------------------------------------------------------------------
// Human-like keyboard input — distributions derived from empirical trace
// (recordings/behavior_2026-04-18T19-26-02-154Z.jsonl):
//   dwell (keyDown→keyUp same key): p50=105ms, p25=89, p75=134, p95=214
//   inter-keystroke (keyDown→next keyDown): p50=169ms, p25=108, p75=225, p95=1301
// Replaces prior arbitrary 50–180ms / 200–450ms spike defaults.
// ---------------------------------------------------------------------------

import { nativeType, nativeSelectAllAndDelete } from './mouse-native.js';
import { cdpInput } from './mouse.js';
import { randomBetween, waitMs } from '../utils/timing.js';

/**
 * Single wheel-down + wheel-up cycle through CDP page.mouse.wheel. Real
 * wheel event (fires wheel + scroll listeners on the scroll container),
 * not Element.scrollIntoView programmatic dispatch.
 *
 * fp_matrix/diff over 54 keeper captures (2026-05-30): Input.wheel reads
 * appeared in 100% of ULTIMATE_PASS captures, 9% of GAUNTLET_STUCK; same
 * pattern for Input.scroll (100%/18%) and performance.interactionCount
 * (100%/9%). Sessions with zero wheel/scroll get their reCAPTCHA v3 score
 * elevated and trip the v2 "Security verification" modal regardless of
 * fingerprint correctness. One down-up cycle populates all three signals.
 *
 * Fail-quiet: page.mouse.wheel can throw on detached contexts; engagement
 * noise is non-fatal, caller never needs to handle.
 */
export async function humanMicroScroll(page: any): Promise<void> {
  try {
    const dy = Math.floor(randomBetween(20, 80));
    await page.mouse.wheel(0, dy);  // allow-raw-playwright: implementation file — defines the humanized atom
    await waitMs(randomBetween(120, 280));
    const back = Math.floor(dy * randomBetween(0.6, 0.9));
    await page.mouse.wheel(0, -back);  // allow-raw-playwright: implementation file — defines the humanized atom
    await waitMs(randomBetween(200, 500));
  } catch { /* engagement noise is non-fatal */ }
}

// Per-char CDP typing with empirical inter-key jitter. Used when
// WELES_INPUT=cdp (parallel-safe per-page path) — page.keyboard
// dispatches into this page's own context, not the host OS queue.
async function cdpType(page: any, text: string): Promise<void> {
  for (const ch of text) {
    await page.keyboard.type(ch);  // allow-raw-playwright: implementation file — defines the humanized atom's cdp transport
    await new Promise((r) => setTimeout(r, 80 + Math.floor(Math.random() * 140)));
  }
}

/**
 * Human-like typing — every keystroke goes through the OS event queue via
 * nativeType (CGEventPost). CDP Input.dispatchKeyEvent and the Playwright
 * keyboard API emit isTrusted=true events but lack the device timestamps
 * and key-event timing jitter that anti-bot classifiers fingerprint on.
 */
export async function humanType(page: any, text: string): Promise<void> {
  if (cdpInput()) { await cdpType(page, text); return; }
  await nativeType(text);
}

/**
 * Locator-aware humanized fill — clicks the field through the humanized
 * mouse pipeline (humanClickLocator → OS event queue), clears any pre-filled
 * value via OS-event Cmd+A then Delete, then types the value via nativeType.
 *
 * Banned alternatives: locator.fill(v) writes via DOM with no keystrokes;
 * locator.pressSequentially with fixed delay produces uniform inter-key
 * timing both of which anti-bot trackers flag.
 */
export async function humanFill(page: any, locator: any, text: string): Promise<void> {
  const { humanClickLocator } = await import('./mouse.js');
  await humanClickLocator(page, locator);
  if (cdpInput()) {
    await page.keyboard.press('ControlOrMeta+A');  // allow-raw-playwright: implementation file — defines the humanized atom's cdp transport
    await page.keyboard.press('Delete');  // allow-raw-playwright: implementation file — defines the humanized atom's cdp transport
    await cdpType(page, text);
    return;
  }
  nativeSelectAllAndDelete();
  await nativeType(text);
}
