// Extra capture surfaces beyond network + property-trap, extracted from
// net_record.ts because that file hit the 300-line cap. All wired from
// startInstrumentation() at WSession.start; data lands on ws._instXxx arrays
// that net_record.ts's buildDumpPayload includes in the merged inst dump.

import type { BrowserContext, Page } from 'playwright';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
export { attachCdpLifecycle } from './capture/cdp_lifecycle.js';

// Service worker registration events. Fires when the page registers / activates
// a SW; relevant because many bot-checks (PerimeterX, Akamai, hCaptcha) ship
// their logic via SW for cross-frame state.
export function attachServiceWorkers(
  ctx: BrowserContext,
  swEvents: unknown[],
): void {
  ctx.on('serviceworker', (sw) => {
    swEvents.push({ t: Date.now(), phase: 'register', url: sw.url() });
  });
}

/**
 * How many levels the pierced DOM tree can hold, measured from a DOMSnapshot:
 * the deepest ancestor chain of each captured document, summed, since a
 * pierced tree nests every frame's document inside its host element.
 */
function snapshotDepth(snapshot: { documents: { nodes: { parentIndex: number[] } }[] }): number {
  let total = Number();
  for (const document of snapshot.documents) {
    const parents = document.nodes.parentIndex;
    let deepest = Number();
    parents.forEach((_, index) => {
      const chain: number[] = [];
      let node = index;
      while (Object.hasOwn(parents, node)) {
        chain.push(node);
        node = parents[node];
      }
      deepest = Math.max(deepest, chain.length);
    });
    total += deepest;
  }
  return total;
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
  const cs =
    'font-family,font-size,font-weight,font-style,font-variant,line-height,letter-spacing,color,background-color,background-image,width,height,min-width,min-height,max-width,max-height,display,position,visibility,opacity,transform,transform-origin,border,border-radius,box-shadow,text-shadow,filter,backdrop-filter,clip-path,overflow,z-index,cursor,pointer-events,user-select,text-align,text-decoration,text-transform,white-space,word-break,direction,writing-mode';
  try {
    ws._instDomSnapshot = await cdp.send('DOMSnapshot.captureSnapshot', {
      computedStyles: cs.split(','),
      includeDOMRects: true,
      includePaintOrder: true,
      includeBlendedBackgroundColors: true,
      includeTextColorOpacities: true,
    });
  } catch (e: any) {
    ws._instDomSnapshotError = String(e?.message ?? e);
  }
  if (ws._instDomSnapshot) {
    try {
      ws._instDomPiercedTree = await cdp.send('DOM.getDocument', {
        depth: snapshotDepth(ws._instDomSnapshot),
        pierce: true,
      });
    } catch (e: any) {
      ws._instDomPiercedTreeError = String(e?.message ?? e);
    }
  } else {
    ws._instDomPiercedTreeError =
      'not captured: its depth is measured from the DOM snapshot, which failed';
  }
  try {
    const chunks: string[] = [];
    const handler = (e: { chunk: string }) => {
      chunks.push(e.chunk);
    };
    cdp.on('HeapProfiler.addHeapSnapshotChunk', handler);
    await cdp.send('HeapProfiler.takeHeapSnapshot', {
      reportProgress: false,
      captureNumericValue: true,
    });
    cdp.off('HeapProfiler.addHeapSnapshotChunk', handler);
    ws._instHeapSnapshot = chunks.join('');
  } catch (e: any) {
    ws._instHeapSnapshotError = String(e?.message ?? e);
  }
}

// Playwright-side page-level event hooks. Complements the CDP Page.* events
// (which fire on the browser side) by also capturing what Playwright's own
// event surface sees — popup/download/dialog/filechooser.
export function attachPagePlaywrightEvents(ws: { page?: Page; _instPlaywrightEvents?: unknown[] }): void {
  const page = ws.page;
  if (!page) return;
  const events: unknown[] = [];
  ws._instPlaywrightEvents = events;
  page.on('popup', (popup) => {
    events.push({ t: Date.now(), phase: 'popup', url: popup.url() });
  });
  page.on('download', (download) => {
    events.push({
      t: Date.now(),
      phase: 'download',
      url: download.url(),
      suggestedFilename: download.suggestedFilename(),
    });
  });
  page.on('filechooser', (chooser) => {
    events.push({ t: Date.now(), phase: 'filechooser', isMultiple: chooser.isMultiple() });
  });
  page.on('dialog', (dialog) => {
    events.push({
      t: Date.now(),
      phase: 'dialog',
      type: dialog.type(),
      message: dialog.message(),
      defaultValue: dialog.defaultValue(),
    });
  });
  page.on('worker', (worker) => {
    events.push({ t: Date.now(), phase: 'worker', url: worker.url() });
  });
  page.on('framenavigated', (frame) => {
    events.push({ t: Date.now(), phase: 'frameNavigated', url: frame.url(), name: frame.name() });
  });
}

/** The message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A sibling file whose stat failed, with why. */
function statFailed(name: string, error: unknown): { name: string; error: string } {
  return { name, error: `stat_failed: ${messageOf(error)}` };
}

/** The directory that could not be listed, with why. */
function listFailed(dir: string, error: unknown): { dir: string; error: string }[] {
  return [{ dir, error: `list_failed: ${messageOf(error)}` }];
}

// Sibling-file manifest: list every file currently in recordings/<label>/
// other than the inst.json itself, with size + mtime. Lets the inst dump
// reference its webm / DOM / screenshots / network.ndjson companions by path
// instead of inlining them.
export function buildSiblingManifest(dir: string, instFn: string): unknown[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    // An empty manifest reads as a run that left no companions; the dump
    // says the directory could not be listed instead.
    return listFailed(dir, error);
  }
  return names
    .filter((n) => join(dir, n) !== instFn)
    .map((n) => {
      try {
        const s = statSync(join(dir, n));
        return { name: n, size: s.size, mtime: s.mtimeMs };
      } catch (statError) {
        return statFailed(n, statError);
      }
    });
}

// Process-wide output capture. Each WSession owns its own list of the lines
// the process printed from startInstrumentation on; every write to the
// process's stdout and stderr streams is appended to the list of every session
// still alive, so concurrent sessions see only their own lines and nothing is
// dropped, whichever console method or direct write printed it. Each line
// names the file descriptor it was written to. A session's list is held
// weakly here: when the session is gone, so is its list, which bounds memory
// by the sessions that exist rather than by a line count. Patches the streams
// once per process; safe to call from every WSession.start.
type ConsoleLine = { t: number; fd: number; line: string };
const SESSION_LINES = new Set<WeakRef<ConsoleLine[]>>();
let _streamsPatched = false;
function teeStream(
  stream: typeof process.stdout | typeof process.stderr,
): void {
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    const entry = {
      t: Date.now(),
      fd: stream.fd,
      line:
        typeof chunk === 'string'
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString('utf8'),
    };
    for (const reference of SESSION_LINES) {
      const lines = reference.deref();
      if (lines) lines.push(entry);
      else SESSION_LINES.delete(reference);
    }
    return write(chunk, ...rest);
  }) as typeof stream.write;
}
function patchStreamsOnce(): void {
  if (_streamsPatched) return;
  _streamsPatched = true;
  teeStream(process.stdout);
  teeStream(process.stderr);
}
export function attachStdoutCapture(ws: { _instStdout?: ConsoleLine[] }): void {
  patchStreamsOnce();
  const lines: ConsoleLine[] = [];
  ws._instStdout = lines;
  SESSION_LINES.add(new WeakRef(lines));
}
/** The lines this session printed, or why none were captured. */
export function sliceStdout(ws: {
  _instStdout?: ConsoleLine[];
}): ConsoleLine[] | { not_captured: string } {
  return ws._instStdout === undefined
    ? { not_captured: 'stdout capture was never attached to this session' }
    : ws._instStdout;
}
