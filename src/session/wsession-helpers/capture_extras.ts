// Extra capture surfaces beyond network + property-trap, extracted from
// net_record.ts because that file hit the 300-line cap. All wired from
// startInstrumentation() at WSession.start; data lands on ws._instXxx arrays
// that net_record.ts's buildDumpPayload includes in the merged inst dump.

import type { BrowserContext } from 'playwright';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
export { attachCdpLifecycle } from './capture/cdp_lifecycle.js';


// Service worker registration events. Fires when the page registers / activates
// a SW; relevant because many bot-checks (PerimeterX, Akamai, hCaptcha) ship
// their logic via SW for cross-frame state.
export function attachServiceWorkers(ctx: BrowserContext, swEvents: any[]): void {
  try {
    (ctx as any).on?.('serviceworker', (sw: any) => {
      try { swEvents.push({ t: Date.now(), phase: 'register', url: sw.url?.() ?? null }); } catch {}
    });
  } catch {}
}

// Final-state CDP captures invoked from finalDump: DOMSnapshot of every frame
// (full DOM tree + computed styles + layout boxes), one HeapProfiler snapshot.
// Both produce large payloads — done once at close, not periodically.
export async function captureFinalCdpSnapshots(ws: any): Promise<void> {
  const cdp = ws?._cdp;
  if (!cdp) return;
  // DOMSnapshot includes shadow tree contents in the documents[] array when
  // captured; CDP's DOMSnapshot.captureSnapshot walks shadow roots by default
  // for open shadow roots. Combined with DOM.getDocument({pierce:true}) for
  // the closed-shadow case via a sibling call.
  // CSS property list for DOMSnapshot computedStyles. Curated set focused on
  // properties bot detectors fingerprint on: font, color, layout, transform,
  // visibility, position. Full ~600-property CSS spec list isn't passed
  // because the resulting snapshot would be 100x larger; this set covers the
  // properties LinkedIn / PerimeterX / Akamai actually read.
  const cs = 'font-family,font-size,font-weight,font-style,font-variant,line-height,letter-spacing,color,background-color,background-image,width,height,min-width,min-height,max-width,max-height,display,position,visibility,opacity,transform,transform-origin,border,border-radius,box-shadow,text-shadow,filter,backdrop-filter,clip-path,overflow,z-index,cursor,pointer-events,user-select,text-align,text-decoration,text-transform,white-space,word-break,direction,writing-mode';
  try { ws._instDomSnapshot = await cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: cs.split(','), includeDOMRects: true, includePaintOrder: true, includeBlendedBackgroundColors: true, includeTextColorOpacities: true }); } catch (e: any) { ws._instDomSnapshotError = String(e?.message ?? e); }
  try { ws._instDomPiercedTree = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }); } catch (e: any) { ws._instDomPiercedTreeError = String(e?.message ?? e); }
  try {
    const chunks: string[] = [];
    const handler = (e: any) => { chunks.push(e?.chunk ?? ''); };
    cdp.on('HeapProfiler.addHeapSnapshotChunk', handler);
    await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: true });
    cdp.off?.('HeapProfiler.addHeapSnapshotChunk', handler);
    ws._instHeapSnapshot = chunks.join('');
  } catch (e: any) { ws._instHeapSnapshotError = String(e?.message ?? e); }
}

// One-shot OS-level snapshots at session start.
export function captureHostSnapshots(ws: any): void {
  const probe = (cmd: string) => { try { return execSync(cmd, { encoding: 'utf8' }); } catch (e: any) { return 'ERR: ' + String(e?.message ?? e); } };
  const isMac = process.platform === 'darwin';
  ws._instHostSnapshots = {
    ps: probe(isMac ? 'ps -axo pid,ppid,user,command' : 'ps -axo pid,ppid,user,cmd'),
    ifconfig: probe(isMac ? 'ifconfig' : 'ip -j addr'),
    route: probe(isMac ? 'netstat -rn' : 'ip -j route'),
    netstat: probe(isMac ? 'netstat -an -p tcp' : 'ss -tan'),
    top: probe(isMac ? 'top -l 1 -n 20 -stats pid,command,cpu,mem,state' : 'top -bn1 -w 200 | head -30'),
    vmstat: probe(isMac ? 'vm_stat' : 'free -m'),
    uptime: probe('uptime'),
    resolv: probe(isMac ? 'scutil --dns 2>/dev/null || cat /etc/resolv.conf' : 'cat /etc/resolv.conf'),
    pmset: probe(isMac ? 'pmset -g batt; pmset -g therm' : 'cat /sys/class/power_supply/BAT0/uevent 2>/dev/null || echo no-battery'),
    sysctl_net: probe(isMac ? 'sysctl -a 2>/dev/null | grep -E "net\\." | head -200' : 'sysctl -a 2>/dev/null | grep -E "net\\." | head -200'),
    launchctl: isMac ? probe('launchctl list | head -100') : probe('systemctl list-units --type=service --state=running | head -100'),
    arp: probe(isMac ? 'arp -an' : 'ip neigh'),
    dns_cache: isMac ? probe('dscacheutil -cachedump -entries 2>/dev/null || echo cache-disabled') : probe('resolvectl statistics 2>/dev/null || echo no-resolvectl'),
    thermal: isMac ? probe('powermetrics -n 1 -i 100 --samplers smc 2>/dev/null | head -50 || echo needs-sudo') : probe('sensors 2>/dev/null || echo no-sensors'),
    lsof_node: probe(`lsof -p ${process.pid} 2>/dev/null | head -100 || echo lsof-failed`),
    sockstat: isMac ? probe('netstat -an -p tcp -p udp 2>/dev/null | head -80') : probe('ss -tani 2>/dev/null | head -80'),
    captured_at: new Date().toISOString(),
  };
}

// Playwright-side page-level event hooks. Complements the CDP Page.* events
// (which fire on the browser side) by also capturing what Playwright's own
// event surface sees — popup/download/dialog/filechooser.
export function attachPagePlaywrightEvents(ws: any): void {
  if (!ws.page) return;
  ws._instPlaywrightEvents = [];
  const push = (e: any) => { try { ws._instPlaywrightEvents.push(e); } catch {} };
  try { ws.page.on?.('popup', (p: any) => push({ t: Date.now(), phase: 'popup', url: p?.url?.() ?? null })); } catch {}
  try { ws.page.on?.('download', (d: any) => push({ t: Date.now(), phase: 'download', url: d?.url?.() ?? null, suggestedFilename: d?.suggestedFilename?.() ?? null })); } catch {}
  try { ws.page.on?.('filechooser', (f: any) => push({ t: Date.now(), phase: 'filechooser', isMultiple: f?.isMultiple?.() ?? null })); } catch {}
  try { ws.page.on?.('dialog', (d: any) => push({ t: Date.now(), phase: 'dialog', type: d?.type?.(), message: d?.message?.(), defaultValue: d?.defaultValue?.() })); } catch {}
  try { ws.page.on?.('worker', (w: any) => push({ t: Date.now(), phase: 'worker', url: w?.url?.() ?? null })); } catch {}
  try { ws.page.on?.('framenavigated', (f: any) => push({ t: Date.now(), phase: 'frameNavigated', url: f?.url?.() ?? null, name: f?.name?.() ?? null })); } catch {}
}

// Periodic ctx.storageState() snapshot. Cookies + localStorage + sessionStorage
// + IndexedDB-origin metadata across all origins the context has touched.
// Captured at start, every 10s thereafter, and on close (via finalDump).
export function pollStorageState(ws: any, ctx: BrowserContext, storageHistory: any[]): void {
  void (async () => { try { storageHistory.push({ t: Date.now(), state: await ctx.storageState() }); } catch {} })();
  ws._instStoragePollId = setInterval(async () => {
    try { storageHistory.push({ t: Date.now(), state: await ctx.storageState() }); } catch {}
  }, 10_000);
}

// Sibling-file manifest: list every file currently in recordings/<label>/
// other than the inst.json itself, with size + mtime. Lets the inst dump
// reference its webm / DOM / screenshots / network.ndjson companions by path
// instead of inlining them.
export function buildSiblingManifest(dir: string, instFn: string): any[] {
  try {
    return readdirSync(dir).filter(n => join(dir, n) !== instFn).map(n => {
      try { const s = statSync(join(dir, n)); return { name: n, size: s.size, mtime: s.mtimeMs }; }
      catch { return { name: n, error: 'stat_failed' }; }
    });
  } catch { return []; }
}

// Process-wide console capture. Tees console method calls into a module-scoped
// ring buffer (capped so a chatty session can't OOM). Each WSession records
// the buffer offset at startInstrumentation and slices from there at dump
// time, so concurrent sessions see only their own lines and sequential
// sessions don't double-count. Patches console once per process; safe to call
// from every WSession.start.
import { CONSOLE_LEVELS } from './capture/capture_constants.js';
const STDOUT_RING: Array<{ t: number; level: string; line: string }> = [];
const STDOUT_RING_CAP = 50_000;
let _consolePatched = false;
function patchConsoleOnce(): void {
  if (_consolePatched) return;
  _consolePatched = true;
  const formats = (args: any[]) => args.map(a => {
    try { return typeof a === 'string' ? a : JSON.stringify(a); }
    catch { return String(a); }
  }).join(' ');
  for (const level of CONSOLE_LEVELS) {
    const orig = (console as any)[level].bind(console);
    (console as any)[level] = (...args: any[]) => {
      try {
        STDOUT_RING.push({ t: Date.now(), level, line: formats(args) });
        if (STDOUT_RING.length > STDOUT_RING_CAP) STDOUT_RING.shift();
      } catch {}
      orig(...args);
    };
  }
}
export function attachStdoutCapture(ws: any): void {
  try { patchConsoleOnce(); ws._instStdoutOffset = STDOUT_RING.length; } catch {}
}
export function sliceStdout(ws: any): any[] {
  try { return STDOUT_RING.slice(ws._instStdoutOffset ?? 0); } catch { return []; }
}
