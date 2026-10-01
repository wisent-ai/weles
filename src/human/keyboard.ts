// ---------------------------------------------------------------------------
// Human-like keyboard input — distributions derived from empirical trace
// (recordings/behavior_2026-04-18T19-26-02-154Z.jsonl):
//   dwell (keyDown→keyUp same key): p50=105ms, p25=89, p75=134, p95=214
//   inter-keystroke (keyDown→next keyDown): p50=169ms, p25=108, p75=225, p95=1301
// Replaces prior arbitrary 50–180ms / 200–450ms spike defaults.
// ---------------------------------------------------------------------------

import { nativeType, nativeSelectAllAndDelete } from './mouse-native.js';
import { cdpInput, humanClickLocator } from './mouse.js';
import { pageSettled, type EvaluatingPage } from '../browser/settled.js';
interface HumanKeyboardPage {
  keyboard: {
    press(key: string): Promise<void>;
    type(text: string): Promise<void>;
  };
}

interface FocusableLocator {
  focus(): Promise<void>;
}

/**
 * Native typing uses the OS event queue through nativeType (CGEventPost).
 * The explicitly selected per-page CDP transport follows input acknowledgements,
 * without adding artificial inter-key pauses or claiming native device timing.
 */
export async function humanType(page: HumanKeyboardPage, text: string): Promise<void> {
  if (cdpInput()) {
    await page.keyboard.type(text);  // allow-raw-playwright: per-page transport, resolved by input acknowledgement
    return;
  }
  await nativeType(text);
}

/**
 * Locator-aware humanized fill — clicks the field through the humanized
 * mouse pipeline (humanClickLocator → OS event queue), waits for any
 * click-triggered adornment update, then focuses that exact locator so a
 * re-render cannot leave the previous field active. It clears any pre-filled
 * value via OS-event Cmd+A then Delete, then types the value via nativeType.
 *
 * Banned alternatives: locator.fill(v) writes via DOM with no keystrokes;
 * locator.pressSequentially with fixed delay produces uniform inter-key
 * timing both of which anti-bot trackers flag.
 */
export async function humanFill(page: HumanKeyboardPage & EvaluatingPage, locator: FocusableLocator, text: string): Promise<void> {
  await humanClickLocator(page, locator);
  await pageSettled(page);
  await locator.focus();
  if (cdpInput()) {
    await page.keyboard.press('ControlOrMeta+A');  // allow-raw-playwright: implementation file — defines the humanized atom's cdp transport
    await page.keyboard.press('Delete');  // allow-raw-playwright: implementation file — defines the humanized atom's cdp transport
    await page.keyboard.type(text);  // allow-raw-playwright: per-page transport, resolved by input acknowledgement
    return;
  }
  nativeSelectAllAndDelete();
  await nativeType(text);
}
