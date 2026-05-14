// Native macOS event emission (CGEventPost-backed). CDP events have
// isTrusted=true but differ from OS-queue events in shape (movementX/Y
// deltas, device timestamps, subpixel coords). LinkedIn's /apfc/collect
// anti-fraud collector fires on OS-queue events only — verified 2026-05-13
// diff: human-on-weles produced 8 /apfc/collect hits, bot-on-weles via CDP
// produced 0.
//
// This module is the ONLY mouse/keyboard path for humanized atoms.

import { execSync, spawnSync } from 'node:child_process';
import { randomBetween, waitMs } from '../utils/timing.js';

export interface NativeOffset { winX: number; winY: number; chromeY: number; }

let nativeAvailable: boolean | null = null;
export function assertCliclickAvailable(): void {
  if (nativeAvailable === true) return;
  if (nativeAvailable === false) throw new Error('cliclick missing — brew install cliclick (required)');  // allow-raw-playwright: implementation file — defines the humanized atom
  try {
    const r = spawnSync('cliclick', ['-V'], { stdio: 'ignore' });  // allow-raw-playwright: implementation file — defines the humanized atom
    nativeAvailable = r.status === 0 || r.status === null;
  } catch { nativeAvailable = false; }
  if (!nativeAvailable) throw new Error('cliclick missing — brew install cliclick (required)');  // allow-raw-playwright: implementation file — defines the humanized atom
}

// Get the browser window's screen position + chrome (title+url+tabs) height
// by evaluating window.screenX/Y/outerHeight/innerHeight in the page. Hard
// fails when the page can't return screenX/Y.
export async function getOffsetFromPage(page: any): Promise<NativeOffset> {
  const r = await page.evaluate(`(() => ({ sX: window.screenX, sY: window.screenY, iH: window.innerHeight, oH: window.outerHeight }))()`);  // allow-raw-playwright: implementation file — defines the humanized atom
  if (!r || typeof r.sX !== 'number') {
    throw new Error('cannot resolve window offset — humanized atoms require OS-coord translation');
  }
  // Empirical 89px on macOS Chromium — outerHeight-innerHeight returns 80
  // but captured clientY is 9px off, consistent with chrome=89.
  return { winX: r.sX, winY: r.sY, chromeY: 89 };
}

function toScreen(off: NativeOffset, cssX: number, cssY: number, jitter = 1): { sx: number; sy: number } {
  return {
    sx: Math.round(off.winX + cssX + randomBetween(-jitter, jitter)),
    sy: Math.round(off.winY + off.chromeY + cssY + randomBetween(-jitter, jitter)),
  };
}

/** Single OS-event mouse move. */
export function nativeMove(offset: NativeOffset, cssX: number, cssY: number): void {
  assertCliclickAvailable();
  const { sx, sy } = toScreen(offset, cssX, cssY);
  spawnSync('cliclick', [`m:${sx},${sy}`], { stdio: 'ignore' });  // allow-raw-playwright: implementation file — defines the humanized atom
}

/**
 * Batched OS-event mouse path. Dispatches one OS move event per waypoint
 * with `dt` for inter-step pacing — Bezier path goes through real OS queue.
 */
export async function nativeBatchMove(offset: NativeOffset, points: Array<{ x: number; y: number; dt?: number }>): Promise<void> {
  assertCliclickAvailable();
  if (!points.length) return;
  for (const p of points) {
    const { sx, sy } = toScreen(offset, p.x, p.y);
    spawnSync('cliclick', [`m:${sx},${sy}`], { stdio: 'ignore' });  // allow-raw-playwright: implementation file — defines the humanized atom
    if (p.dt && p.dt > 0) await waitMs(Math.min(p.dt, 120));
  }
}

/** OS-event click. Moves to (x,y) first then clicks at the same coord. */
export async function nativeClick(offset: NativeOffset, cssX: number, cssY: number): Promise<void> {
  assertCliclickAvailable();
  const { sx, sy } = toScreen(offset, cssX, cssY);
  spawnSync('cliclick', [`m:${sx},${sy}`, `c:${sx},${sy}`], { stdio: 'ignore' });  // allow-raw-playwright: implementation file — defines the humanized atom
}

/** OS-event typing — one char per spawn, with empirical inter-key timing. */
export async function nativeType(text: string): Promise<void> {
  assertCliclickAvailable();
  for (const ch of text) {
    spawnSync('cliclick', [`t:${ch}`], { stdio: 'ignore' });  // allow-raw-playwright: implementation file — defines the humanized atom
    await waitMs(randomBetween(80, 220));
  }
}

/**
 * OS-event keypress. Maps portable key names to keycodes.
 * Supported: 'enter'|'return', 'tab', 'esc'|'escape', 'delete'|'backspace',
 * 'space', 'arrow-down'|'down', 'arrow-up'|'up', 'arrow-left'|'left',
 * 'arrow-right'|'right'. Unknown keys throw.
 */
export function nativeKeyPress(key: string): void {
  assertCliclickAvailable();
  const k = key.toLowerCase();
  const map: Record<string, string> = {
    'enter': 'return', 'return': 'return',
    'tab': 'tab',
    'esc': 'esc', 'escape': 'esc',
    'delete': 'delete', 'backspace': 'delete',
    'space': 'space',
    'arrow-down': 'arrow-down', 'down': 'arrow-down',
    'arrow-up': 'arrow-up', 'up': 'arrow-up',
    'arrow-left': 'arrow-left', 'left': 'arrow-left',
    'arrow-right': 'arrow-right', 'right': 'arrow-right',
  };
  const kc = map[k];
  if (!kc) throw new Error(`nativeKeyPress: unsupported key ${key}`);
  spawnSync('cliclick', [`kp:${kc}`], { stdio: 'ignore' });  // allow-raw-playwright: implementation file — defines the humanized atom
}

/** Select-all-and-delete via OS event queue. Cmd+A then Delete. */
export function nativeSelectAllAndDelete(): void {
  assertCliclickAvailable();
  spawnSync('cliclick', ['kd:cmd', 't:a', 'ku:cmd', 'kp:delete'], { stdio: 'ignore' });  // allow-raw-playwright: implementation file — defines the humanized atom
}

export function getWindowOffset(processName = 'Chromium'): NativeOffset {
  // Default: assume --window-position=0,0 in CHROMIUM_ARGS (browser pinned
  // to screen top-left). macOS menu bar is 25px tall; Chromium title+url+tabs
  // add ~85px. Total chromeY = 85. Override via env if unavailable.
  const envX = parseInt(process.env.WELES_WIN_X ?? '0', 10);
  const envY = parseInt(process.env.WELES_WIN_Y ?? '0', 10);
  const envC = parseInt(process.env.WELES_CHROME_Y ?? '85', 10);
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
