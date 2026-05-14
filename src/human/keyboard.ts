// ---------------------------------------------------------------------------
// Human-like keyboard input — distributions derived from empirical trace
// (recordings/behavior_2026-04-18T19-26-02-154Z.jsonl):
//   dwell (keyDown→keyUp same key): p50=105ms, p25=89, p75=134, p95=214
//   inter-keystroke (keyDown→next keyDown): p50=169ms, p25=108, p75=225, p95=1301
// Replaces prior arbitrary 50–180ms / 200–450ms spike defaults.
// ---------------------------------------------------------------------------

import { nativeType, nativeSelectAllAndDelete } from './mouse-native.js';

/**
 * Human-like typing — every keystroke goes through the OS event queue via
 * nativeType (CGEventPost). CDP Input.dispatchKeyEvent and the Playwright
 * keyboard API emit isTrusted=true events but lack the device timestamps
 * and key-event timing jitter that anti-bot classifiers fingerprint on.
 */
export async function humanType(_page: any, text: string): Promise<void> {
  void _page;
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
  nativeSelectAllAndDelete();
  await nativeType(text);
}
