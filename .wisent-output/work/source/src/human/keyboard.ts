// ---------------------------------------------------------------------------
// Human-like keyboard input — distributions derived from empirical trace
// (recordings/behavior_2026-04-18T19-26-02-154Z.jsonl):
//   dwell (keyDown→keyUp same key): p50=105ms, p25=89, p75=134, p95=214
//   inter-keystroke (keyDown→next keyDown): p50=169ms, p25=108, p75=225, p95=1301
// Replaces prior arbitrary 50–180ms / 200–450ms spike defaults.
// ---------------------------------------------------------------------------

import { nativeType, nativeSelectAllAndDelete } from './mouse-native.js';
import { cdpInput } from './mouse.js';
import { humanRandom } from '../utils/timing.js';

// Per-char CDP typing with empirical inter-key jitter. Used when
// WELES_INPUT=cdp (parallel-safe per-page path) — page.keyboard
// dispatches into this page's own context, not the host OS queue.
async function cdpType(page: any, text: string): Promise<void> {
  for (const ch of text) {
    await page.keyboard.type(ch);  // allow-raw-playwright: implementation file — defines the humanized atom's cdp transport
    await new Promise((r) => setTimeout(r, 80 + Math.floor(humanRandom() * 140)));
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
