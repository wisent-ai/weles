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
async function resolveCdpSend(page: any): Promise<((method: string, params?: any) => Promise<any>)> {
  if (typeof page.send === 'function') return page.send.bind(page);
  const ctx = typeof page.context === 'function' ? page.context() : null;
  if (ctx && typeof ctx.newCDPSession === 'function') {
    const cdp = await ctx.newCDPSession(page);
    return cdp.send.bind(cdp);
  }
  throw new Error('humanType: page has no .send and no .context().newCDPSession() — attach a CDP session');
}

export async function humanType(page: any, text: string): Promise<void> {
  const send = await resolveCdpSend(page);
  for (const char of text) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', text: char, key: char, unmodifiedText: char });
    await waitMs(sampleDwellMs());
    await send('Input.dispatchKeyEvent', { type: 'keyUp', text: char, key: char, unmodifiedText: char });
    await waitMs(sampleInterKeyMs());
  }
}
