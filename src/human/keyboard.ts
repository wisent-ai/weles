// ---------------------------------------------------------------------------
// Human-like keyboard input — distributions derived from empirical trace
// (recordings/behavior_2026-04-18T19-26-02-154Z.jsonl):
//   dwell (keyDown→keyUp same key): p50=105ms, p25=89, p75=134, p95=214
//   inter-keystroke (keyDown→next keyDown): p50=169ms, p25=108, p75=225, p95=1301
// Replaces prior arbitrary 50–180ms / 200–450ms spike defaults.
// ---------------------------------------------------------------------------

import { randomBetween, waitMs } from '../utils/timing.js';
import { traceAvailable, nextInterKeyMs, nextDwellMs } from './trace.js';

export interface KeyboardPage {
  send(method: string, params?: Record<string, any>): Promise<any>;
}

// Trace-replay cursors take priority. If no trace loaded, we keep the
// distribution-bin defaults derived from the same trace so the module stays
// functional without recordings/behavior_*.jsonl present.
function sampleDwellMs(): number {
  if (traceAvailable()) return nextDwellMs();
  const r = Math.random();
  if (r < 0.25) return randomBetween(52, 89);
  if (r < 0.75) return randomBetween(89, 134);
  if (r < 0.95) return randomBetween(134, 214);
  return randomBetween(214, 320);
}

function sampleInterKeyMs(): number {
  if (traceAvailable()) return nextInterKeyMs();
  const r = Math.random();
  if (r < 0.25) return randomBetween(61, 108);
  if (r < 0.75) return randomBetween(108, 225);
  if (r < 0.95) return randomBetween(225, 700);
  return randomBetween(700, 1800);
}

// Resolves a CDP send function for a Playwright Page, a raw CDP session, or
// a plain object that already exposes `.send`. Playwright Pages don't expose
// CDP as `page.send` so we create a new session via `page.context().newCDPSession`.
// Required path: page.keyboard.down/up silently drops characters that need
// modifiers (uppercase, @, punctuation) around char 18 when GitHub's async
// validator re-renders the input element, so we must not use it.
async function resolveCdpSend(page: any): Promise<((method: string, params?: any) => Promise<any>) | null> {
  if (typeof page.send === 'function') return page.send.bind(page);
  const ctx = typeof page.context === 'function' ? page.context() : null;
  if (ctx && typeof ctx.newCDPSession === 'function') {
    try {
      const cdp = await ctx.newCDPSession(page);
      return cdp.send.bind(cdp);
    } catch {
      // CDP session creation failed (e.g. Firefox). Return null to signal
      // the caller should fall back to page.keyboard.
      return null;
    }
  }
  return null;
}

export async function humanType(page: any, text: string): Promise<void> {
  const send = await resolveCdpSend(page);
  if (send) {
    // CDP path — dispatches one Input.dispatchKeyEvent per character with
    // empirical-trace dwell + inter-key timing. Chromium only.
    for (const char of text) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char, unmodifiedText: char });
      await waitMs(sampleDwellMs());
      await send('Input.dispatchKeyEvent', { type: 'keyUp', text: char, key: char, unmodifiedText: char });
      await waitMs(sampleInterKeyMs());
    }
  } else {
    // Firefox fallback — page.keyboard.down/up with manual inter-key timing.
    // Firefox's keyboard API doesn't suffer from the Chromium modifier-drop
    // bug, so this works correctly for uppercase, @, punctuation, etc.
    for (const char of text) {
      const shift = char !== char.toLowerCase() || /[^a-z0-9]/.test(char);
      if (shift) await page.keyboard.down('Shift');
      await page.keyboard.down(char);
      await waitMs(sampleDwellMs());
      await page.keyboard.up(char);
      if (shift) await page.keyboard.up('Shift');
      await waitMs(sampleInterKeyMs());
    }
  }
}

/**
 * Locator-aware humanized fill — the atom for "type into this field".
 *
 * Clicks the element through the humanized mouse pipeline (real mouse events,
 * Bezier path, randomized in-element offset), clears any pre-filled value
 * (Reddit's signup auto-suggests usernames; Instagram pre-fills suggested
 * email — both observed silently overriding our typed input), then dispatches
 * one keystroke per character via CDP with empirical-distribution dwell+inter-
 * key timing.
 *
 * Use this anywhere a trajectory needs to fill a form field. Do NOT call
 * `locator.fill(v)` (writes via DOM with NO keystrokes — anti-bot signal),
 * `locator.pressSequentially(v, {delay: N})` (fixed-delay timing — anti-bot
 * signal), or `page.keyboard.type(v, {delay: N})` (same as pressSequentially).  // allow-raw-playwright: implementation file — defines the humanized atom
 */
export async function humanFill(page: any, locator: any, text: string): Promise<void> {
  const { humanClickLocator } = await import('./mouse.js');
  await humanClickLocator(page, locator);
  // Select-all + delete to clear any pre-filled value. Use ControlOrMeta so it
  // works on both macOS (Cmd+A) and Windows/Linux (Ctrl+A).
  try {
    if (typeof page.keyboard?.press === 'function') {
      await page.keyboard.press('ControlOrMeta+A');
      await page.keyboard.press('Delete');
    }
  } catch { /* keyboard not available — skip clear */ }
  await humanType(page, text);
}
