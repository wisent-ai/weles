// Native macOS event emission through CGEventPost (cliclick). OS-queue events
// retain native movement deltas, timestamps, and subpixel coordinates.
//
// A page coordinate becomes a screen coordinate by the page content's screen
// origin, measured, never assumed: cliclick puts the OS pointer inside the
// window, and the page's own pointer event states its screen and client
// position at once, so their difference is where the content sits on screen.

import { execFileSync, spawnSync } from 'node:child_process';
import { humanRandom } from '../utils/motion/timing.js';

/** Where the page's content area starts on screen, in screen points. */
export interface NativeOffset {
  winX: number;
  winY: number;
}

let nativeAvailable = false;

function runCliclick(
  operation: string,
  args: string[],
  sensitiveText?: string,
): void {
  const result = spawnSync('cliclick', args, {
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (!result.error && result.signal === null && !result.status) return;
  const said = result.error ? result.error.message : result.stderr.trim();
  const detail = sensitiveText
    ? said.replaceAll(sensitiveText, '[redacted]')
    : said;
  throw new Error(
    `native input ${operation} failed: error=${JSON.stringify((result.error as NodeJS.ErrnoException | undefined)?.code)}, status=${result.status}, signal=${result.signal}; ${detail}`,
  );
}

export function assertCliclickAvailable(): void {
  if (nativeAvailable) return;
  runCliclick('availability probe', ['-V']);
  nativeAvailable = true;
}

// The parent of process `pid` as `ps` reports it; 0 above the first process.
function parentOf(pid: number): number {
  const answer = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
  if (!/^\d+$/.test(answer))
    throw new Error(
      `ps answered ${JSON.stringify(answer)} for the parent of ${pid}`,
    );
  return Number(answer);
}

function assertNativeInputTargetIsFrontmost(): void {
  // Native input is global OS input. If another app is frontmost, cliclick will
  // drive that app, not the intended Weles window. Fail closed unless the
  // foreground process is a browser this run launched: a descendant of this
  // process, whatever the browser's application is called.
  const allowAny = process.env.WELES_NATIVE_INPUT_ALLOW_ANY_FRONTMOST === '1';
  if (allowAny) return;

  let frontmost: { name: string; pid: number };
  try {
    const answer = execFileSync(
      'osascript',
      [
        '-e',
        'tell application "System Events" to get {name, unix id} of first application process whose frontmost is true',
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    ).trim();
    const read = /^(?<name>.*),\s*(?<pid>\d+)$/.exec(answer);
    if (!read?.groups)
      throw new Error(`System Events answered ${JSON.stringify(answer)}`);
    frontmost = { name: read.groups.name, pid: Number(read.groups.pid) };
  } catch (error) {
    throw new Error(
      `native input blocked: cannot verify frontmost application: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (let pid = frontmost.pid; pid; pid = parentOf(pid)) {
    if (pid === process.pid) return;
  }
  throw new Error(
    `native input blocked: frontmost application is "${frontmost.name}" (pid ${frontmost.pid}), which this run (pid ${process.pid}) did not launch; bring its browser window to the front`,
  );
}

/** The measured content origin of each page, kept for the page's life. */
const measured = new WeakMap<object, NativeOffset>();

/**
 * The screen origin of the page's content area. The OS pointer is put at a
 * point the window's own frame places inside its content (below the toolbar,
 * within the content's width), and the page's next pointer event answers
 * screenX - clientX and screenY - clientY: the origin, as the browser itself
 * maps the two. A page that is not focused and visible is refused.
 */
export async function getOffsetFromPage(page: any): Promise<NativeOffset> {
  const known = measured.get(page);
  if (known) return known;
  const frame = await page.evaluate(
    `(() => ({ sX: window.screenX, sY: window.screenY, iW: window.innerWidth, iH: window.innerHeight, oH: window.outerHeight, visibility: document.visibilityState, focused: document.hasFocus(), href: location.href }))()`,
  ); // allow-raw-playwright: implementation file — defines the humanized atom
  if (!frame || typeof frame.sX !== 'number' || typeof frame.oH !== 'number') {
    throw new Error(
      'cannot read the window frame (screenX/screenY/innerWidth/innerHeight/outerHeight) of the page native input drives',
    );
  }
  if (
    process.env.WELES_NATIVE_INPUT_ALLOW_UNFOCUSED !== '1' &&
    (frame.visibility !== 'visible' || frame.focused !== true)
  ) {
    throw new Error(
      `native input blocked: target page is not focused and visible (visibility=${frame.visibility}, focused=${frame.focused}, href=${frame.href})`,
    );
  }
  assertCliclickAvailable();
  assertNativeInputTargetIsFrontmost();
  await page.evaluate(
    `(() => { delete window.__welesContentOrigin; addEventListener('pointermove', (e) => { window.__welesContentOrigin = { winX: e.screenX - e.clientX, winY: e.screenY - e.clientY }; }, { once: true, capture: true }); })()`,
  ); // allow-raw-playwright: implementation file — reads the origin the browser maps
  const probeX = Math.round(frame.sX + frame.iW * humanRandom());
  const probeY = Math.round(frame.sY + frame.oH - frame.iH * humanRandom());
  runCliclick('content origin probe', [`m:${probeX},${probeY}`]);
  const handle = await page.waitForFunction('window.__welesContentOrigin'); // allow-raw-playwright: the page's own answer to the probe
  const origin = (await handle.jsonValue()) as NativeOffset;
  measured.set(page, origin);
  return origin;
}

function toScreen(
  off: NativeOffset,
  cssX: number,
  cssY: number,
): { sx: number; sy: number } {
  return {
    sx: Math.round(off.winX + cssX),
    sy: Math.round(off.winY + cssY),
  };
}

/** Single OS-event mouse move. */
export function nativeMove(
  offset: NativeOffset,
  cssX: number,
  cssY: number,
): void {
  assertCliclickAvailable();
  assertNativeInputTargetIsFrontmost();
  const { sx, sy } = toScreen(offset, cssX, cssY);
  runCliclick('pointer move', [`m:${sx},${sy}`]);
}

/**
 * OS-event mouse path. Each waypoint is dispatched in order, without a Weles
 * inter-step pause. The external cliclick tool still owns its event delivery.
 */
export async function nativeBatchMove(
  offset: NativeOffset,
  points: Array<{ x: number; y: number }>,
): Promise<void> {
  assertCliclickAvailable();
  assertNativeInputTargetIsFrontmost();
  for (const p of points) {
    const { sx, sy } = toScreen(offset, p.x, p.y);
    runCliclick('pointer waypoint', [`m:${sx},${sy}`]);
  }
}

/** OS-event click. Moves to (x,y) first then clicks at the same coord. */
export async function nativeClick(
  offset: NativeOffset,
  cssX: number,
  cssY: number,
): Promise<void> {
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

/** Select-all-and-delete via OS event queue. Cmd+A then Delete. */
export function nativeSelectAllAndDelete(): void {
  assertCliclickAvailable();
  assertNativeInputTargetIsFrontmost();
  runCliclick('select all and delete', [
    'kd:cmd',
    't:a',
    'ku:cmd',
    'kp:delete',
  ]);
}
