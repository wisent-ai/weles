// The merged instrumentation dump of one WSession: wires every capture
// surface at start, writes the dump on browser activity, steps and close. The
// complete network record itself lives in capture/network_record.ts and the
// dump's shape in capture/dump_payload.ts. The shared `reqs` array is exposed
// via `(ws as any)._instRequests` so finalize.ts can write the final dump.

import type { BrowserContext } from 'playwright';
import {
  platform as osPlatform,
  release as osRelease,
  arch as osArch,
  totalmem,
  cpus,
  hostname,
  version as osVersion,
} from 'node:os';
import { join } from 'node:path';
import {
  attachServiceWorkers,
  attachCdpLifecycle,
  attachStdoutCapture,
  captureFinalCdpSnapshots,
  attachPagePlaywrightEvents,
} from './capture_extras.js';
import { captureHostSnapshots } from './capture/host_snapshots.js';
import { startPcap, stopPcap, attachWorkerInventory } from './pcap_sidecar.js';
import { recordingsDir } from '../run-recordings.js';
import { attachInstrumentationCheckpoints } from './capture/checkpoints/activity.js';
import { attachCompleteNetRecord } from './capture/network_record.js';
import { buildDumpPayload } from './capture/dump_payload.js';
// Captured page/network payloads can contain lone UTF-16 surrogates; the
// writer replaces them at the artifact edge and never builds the whole dump
// as one string, which a long run outgrows.
import { writeJsonFile } from './capture/artifact/json_file.js';

/** Whether the diagnostic `name` runs: under WELES_FULL_DIAGNOSTICS, or WELES_<name>_DIAGNOSTICS=1. */
function diagnosticEnabled(name: string): boolean {
  return (
    process.env.WELES_FULL_DIAGNOSTICS === '1' ||
    process.env[`WELES_${name}_DIAGNOSTICS`] === '1'
  );
}

/** The message of a failure, whatever was thrown. */
function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// One merged fingerprint artifact per session, written as <time>.inst.json in
// the session's recordings directory (recordings/<run>/<label>/, or the run's
// own directory for an unlabelled session), so the worker uploader
// (src/worker/upload-artifacts.ts) keeps it with the webm and DOM snapshots
// under the private stado://weles/recordings/ tree. The capture surface has
// no domain filter and no body truncation, and runs on every WSession.
export function startInstrumentation(
  ws: any,
  ctx: BrowserContext,
  label: string | undefined,
): any[] {
  const cdpDiagnostics = diagnosticEnabled('CDP');
  const storageDiagnostics = diagnosticEnabled('STORAGE');
  const dir = recordingsDir(label);
  const startedAt = new Date().toISOString();
  const fn = join(dir, `${startedAt.replace(/[:.]/g, '-')}.inst.json`);
  const reqs: any[] = [];
  const consoleMsgs: any[] = [];
  const pageErrors: any[] = [];
  const swEvents: any[] = [];
  const targetEvents: any[] = [];
  const frameEvents: any[] = [];
  ws._instRequests = reqs;
  ws._instConsole = consoleMsgs;
  ws._instPageErrors = pageErrors;
  ws._instSwEvents = swEvents;
  ws._instTargetEvents = targetEvents;
  ws._instFrameEvents = frameEvents;
  ws._instMetricsHistory = [];
  ws._instDomCounters = [];
  ws._instStorageHistory = [];
  ws._instAccum = new Map();
  ws._instFile = fn;
  ws._instDir = dir;
  ws._instStartedAt = startedAt;
  const [cpu] = cpus();
  ws._instHost = {
    platform: osPlatform(),
    release: osRelease(),
    arch: osArch(),
    version: osVersion(),
    hostname: hostname(),
    totalmem: totalmem(),
    cpu_count: cpus().length,
    cpu_model: cpu ? cpu.model : null,
    node_version: process.version,
    pid: process.pid,
  };
  ws._instStdout = [];
  ws._instDomTimeline = [];
  attachStdoutCapture(ws);
  attachCompleteNetRecord(ctx, reqs);
  attachPageDiagnostics(ws, consoleMsgs, pageErrors);
  attachServiceWorkers(ctx, swEvents);
  if (cdpDiagnostics)
    ws._cdpDiagnosticsReady = attachCdpLifecycle(
      ws,
      ctx,
      targetEvents,
      frameEvents,
    );
  if (diagnosticEnabled('PCAP')) startPcap(ws, label);
  if (diagnosticEnabled('WORKER')) attachWorkerInventory(ws);
  if (diagnosticEnabled('HOST')) captureHostSnapshots(ws);
  attachPagePlaywrightEvents(ws);
  ws._instCheckpoints = attachInstrumentationCheckpoints(
    ws,
    ctx,
    { cdpDiagnostics, storageDiagnostics },
    () => writeJsonFile(fn, buildDumpPayload(ws, { closing: false })),
  );
  return reqs;
}

/** Run one closing CDP step; a refusal is kept on `errorKey` beside its capture. */
async function cdpStep(
  ws: any,
  errorKey: string,
  step: () => Promise<void>,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    ws[errorKey] = failure(error);
  }
}

// Drain activity captures before final protocol snapshots and one closing dump.
export async function finalDump(ws: any): Promise<void> {
  await ws._cdpDiagnosticsReady;
  if (ws._instCheckpoints) await ws._instCheckpoints.stop();
  if (!ws._instFile) return;
  // End CDP Tracing and coverage first so their results are in the dump.
  const cdp = ws._cdp;
  if (cdp) {
    await cdpStep(ws, '_instTracingEndError', () => cdp.send('Tracing.end'));
    await cdpStep(ws, '_instJsCoverageEndError', async () => {
      ws._instJsCoverageData = await cdp.send('Profiler.takePreciseCoverage');
      await cdp.send('Profiler.stopPreciseCoverage');
    });
    await cdpStep(ws, '_instCssCoverageEndError', async () => {
      ws._instCssCoverageData = await cdp.send('CSS.takeCoverageDelta');
      await cdp.send('CSS.stopRuleUsageTracking');
    });
  }
  // One-shot DOMSnapshot + HeapProfiler at close — captured before pcap/page
  // teardown so the snapshots reflect the actual final state of the session.
  try {
    await captureFinalCdpSnapshots(ws);
  } catch (error) {
    console.error(
      `[wsession] final DOMSnapshot/HeapProfiler capture failed: ${failure(error)}`,
    );
  }
  try {
    await stopPcap(ws);
  } catch (error) {
    console.error(`[wsession] pcap sidecar stop failed: ${failure(error)}`);
  }
  try {
    if (ws._instCheckpoints) await ws._instCheckpoints.captureFinal();
    writeJsonFile(ws._instFile, buildDumpPayload(ws, { closing: true }));
    console.log(`[wsession] final inst dump -> ${ws._instFile}`);
  } catch (error) {
    console.error(
      `[wsession] final instrumentation dump ${ws._instFile} failed: ${failure(error)}`,
    );
  }
}

// Console messages, uncaught page errors and a page crash ride in the same
// merged dump. Each console event keeps its type, text, location and each
// argument's value, or why that value could not be read.
function attachPageDiagnostics(
  ws: any,
  consoleMsgs: any[],
  pageErrors: any[],
): void {
  ws.page.on('console', async (msg: any) => {
    const read = await Promise.allSettled(
      msg.args().map((handle: any) => handle.jsonValue()),
    );
    consoleMsgs.push({
      t: Date.now(),
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
      args: read.map((outcome) =>
        outcome.status === 'fulfilled'
          ? { value: outcome.value }
          : { unreadable: failure(outcome.reason) },
      ),
    });
    void ws._instCheckpoints?.checkpoint('console');
  });
  ws.page.on('pageerror', (err: Error) => {
    pageErrors.push({
      t: Date.now(),
      name: err.name,
      message: err.message,
      stack: err.stack,
    });
  });
  ws.page.on('crash', () => {
    pageErrors.push({
      t: Date.now(),
      name: 'crash',
      message: 'page crashed',
      stack: null,
    });
  });
}
