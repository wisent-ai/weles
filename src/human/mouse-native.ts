// Native macOS event emission through CGEventPost. OS-queue events retain
// native movement deltas, timestamps, and subpixel coordinates.
//
// This module is the ONLY mouse/keyboard path for humanized atoms.

import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { randomBetween } from '../utils/motion/timing.js';

export interface NativeOffset { winX: number; winY: number; chromeY: number; }

let nativeAvailable = false;

function runCliclick(operation: string, args: string[], sensitiveText = ''): void {
  const result = spawnSync('cliclick', args, { encoding: 'utf8', stdio: 'pipe' });
  if (!result.error && result.status === 0) return;
  let detail = result.error?.message ?? (result.stderr?.trim() || 'no error output');
  if (sensitiveText) detail = detail.replaceAll(sensitiveText, '[redacted]');
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code ?? 'none';
  throw new Error(`native input ${operation} failed: code=${code}, status=${result.status ?? 'none'}, signal=${result.signal ?? 'none'}; ${detail}`);
}

export function assertCliclickAvailable(): void {
  if (nativeAvailable) return;
  runCliclick('availability probe', ['-V']);
  nativeAvailable = true;
}

function assertNativeInputTargetIsFrontmost(): void {
  // Native input is global OS input. If another app is frontmost, cliclick will
  // drive that app, not the intended Weles window. Fail closed unless the
  // foreground process is explicitly allowed.
  const allowAny = process.env.WELES_NATIVE_INPUT_ALLOW_ANY_FRONTMOST === '1';
  if (allowAny) return;

  let frontmost = '';
  try {
    frontmost = execFileSync('osascript', [
      '-e',
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ], { encoding: 'utf8', stdio: 'pipe' }).trim();
  } catch (error) {
    throw new Error(`native input blocked: cannot verify frontmost application: ${error instanceof Error ? error.message : String(error)}`);
  }

  const allowed = process.env.WELES_NATIVE_INPUT_FRONTMOST_RE ?? '^(Chromium|Google Chrome|Weles)$';
  if (!new RegExp(allowed).test(frontmost)) {
    throw new Error(`native input blocked: frontmost application is "${frontmost}", expected ${allowed}`);
  }
}

// Get the browser window's screen position + chrome (title+url+tabs) height
// by evaluating window.screenX/Y/outerHeight/innerHeight in the page. Hard
// fails when the page can't return screenX/Y.
export async function getOffsetFromPage(page: any): Promise<NativeOffset> {
  const r = await page.evaluate(`(() => ({ sX: window.screenX, sY: window.screenY, iH: window.innerHeight, oH: window.outerHeight, visibility: document.visibilityState, focused: document.hasFocus(), href: location.href }))()`);  // allow-raw-playwright: implementation file — defines the humanized atom
  if (!r || typeof r.sX !== 'number') {
    throw new Error('cannot resolve window offset — humanized atoms require OS-coord translation');
  }
  if (process.env.WELES_NATIVE_INPUT_ALLOW_UNFOCUSED !== '1' && (r.visibility !== 'visible' || r.focused !== true)) {
    throw new Error(`native input blocked: target page is not focused and visible (visibility=${r.visibility}, focused=${r.focused}, href=${r.href})`);
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
  assertNativeInputTargetIsFrontmost();
  const { sx, sy } = toScreen(offset, cssX, cssY);
  runCliclick('pointer move', [`m:${sx},${sy}`]);
}

/**
 * OS-event mouse path. Each waypoint is dispatched in order, without a Weles
 * inter-step pause. The external cliclick tool still owns its event delivery.
 */
export async function nativeBatchMove(offset: NativeOffset, points: Array<{ x: number; y: number }>): Promise<void> {
  assertCliclickAvailable();
  assertNativeInputTargetIsFrontmost();
  if (!points.length) return;
  for (const p of points) {
    const { sx, sy } = toScreen(offset, p.x, p.y);
    runCliclick('pointer waypoint', [`m:${sx},${sy}`]);
  }
}

/** OS-event click. Moves to (x,y) first then clicks at the same coord. */
export async function nativeClick(offset: NativeOffset, cssX: number, cssY: number): Promise<void> {
  assertCliclickAvailable();
  assertNativeInputTargetIsFrontmost();
  const { sx, sy } = toScreen(offset, cssX, cssY);
  runCliclick('click', [`m:${sx},${sy}`, `c:${sx},${sy}`]);
}

/** OS-event typing; each character's command must succeed before the next. */
export async function nativeType(text: string): Promise<void> {
  assertCliclickAvailable();
  assertNativeInputTargetIsFrontmost();
  for (const ch of text) {
    runCliclick('typing', [`t:${ch}`], ch);
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
  assertNativeInputTargetIsFrontmost();
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
  runCliclick('keypress', [`kp:${kc}`]);
}

/** Select-all-and-delete via OS event queue. Cmd+A then Delete. */
export function nativeSelectAllAndDelete(): void {
  assertCliclickAvailable();
  assertNativeInputTargetIsFrontmost();
  runCliclick('select all and delete', ['kd:cmd', 't:a', 'ku:cmd', 'kp:delete']);
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
