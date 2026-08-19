/**
 * Shared runtime for the evidence-capture actions (generic_capture,
 * generic_accessibility_audit).
 *
 * These two actions are unlike the rest of scripts/trajectories/: no model, no
 * account, no login. They render one URL exactly as asked and produce attributed
 * artifacts. What they share, and what lives here:
 *
 *   - a session started with the page left pristine (no in-page instrumentation
 *     and no Playwright video), because a landing-page still is the product's
 *     own rendering and injected property traps have no business being in it;
 *   - the viewport applied through CDP Emulation.setDeviceMetricsOverride, the
 *     only path that honours device_scale_factor;
 *   - the renderer string read from the live browser (Browser.getVersion), never
 *     assumed from the persona;
 *   - the weles release identity the worker already computes for every row;
 *   - upload into the stado://weles-captures/ namespace through the same
 *     authenticated product-object API the recordings uploader uses. A failed
 *     upload throws: an artifact that exists only on the host is not evidence.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../../dist/session/wsession.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { putPrivateStadoObject } from '../../../dist/worker/upload-artifacts.js';
import { captureVersions } from '../../../dist/diagnostics/versions.js';
import { CAPTURE_ARTIFACT_ROOT } from '../../../dist/worker/capture-params.js';

export const CAPTURE_NAMESPACE = 'weles-captures';

// The release identity of the code that produced the artifact: the package
// version plus the exact commit, marked dirty when the worktree that ran is not
// the committed one. Same source captureVersions writes onto every action row.
export function welesVersion() {
  const versions = captureVersions(null);
  const pkg = typeof versions.weles_pkg_version === 'string' ? versions.weles_pkg_version : '0.0.0';
  const commit = typeof versions.weles_commit_short === 'string' ? versions.weles_commit_short : 'unknown';
  return `${pkg}+${commit}${versions.weles_dirty === true ? '-dirty' : ''}`;
}

export function planFromEnv(name, parse) {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required`);
  return parse(JSON.parse(raw));
}

// A pristine chromium session on the Stado-selected host, with the requested
// viewport and device scale factor already in force.
export async function startCaptureSession(label, plan) {
  process.env.WELES_PAGE_DIAGNOSTICS = '0';
  process.env.WELES_DISABLE_RECORDING = '1';
  const session = await WSession.start({
    label,
    proxy: 'none',
    targetHost: new URL(plan.source_url).hostname,
    headless: process.env.WELES_CAPTURE_HEADLESS !== '0',
    browser: 'chromium',
  });
  const cdp = await session.ctx.newCDPSession(session.page);
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: plan.viewport.width,
    height: plan.viewport.height,
    deviceScaleFactor: plan.viewport.device_scale_factor,
    mobile: false,
  });
  await session.page.setViewportSize({ width: plan.viewport.width, height: plan.viewport.height });
  const version = await cdp.send('Browser.getVersion');
  const renderer = String(version?.product ?? '').trim();
  if (!renderer) throw new Error('the live browser did not report a build string; the capture would have no renderer attribution');
  return { session, cdp, renderer };
}

// CDPScreencast speaks the worker's own CDPConnection shape (method, params,
// sessionId). A Playwright CDPSession is already bound to one target, so the
// session id is carried implicitly and dropped here.
export function screencastConnection(cdp) {
  return {
    on(event, handler) { cdp.on(event, handler); },
    off(event, handler) { cdp.off(event, handler); },
    send(method, params) { return cdp.send(method, params ?? {}); },
  };
}

export function writeLocalArtifact(label, name, bytes) {
  const path = join(runRecordingsDir(label), name);
  writeFileSync(path, bytes);
  return path;
}

// Attribution is read back off the written file, never off the buffer we think
// we wrote, so bytes and sha256 describe the object that actually exists.
export function fileAttribution(path) {
  const bytes = readFileSync(path);
  return { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), buffer: bytes };
}

export function pngPixelSize(buffer) {
  if (buffer.length < 24 || buffer.readUInt32BE(Number('0')) !== 0x89504e47) {
    throw new Error('the captured still is not a PNG, so its pixel size cannot be attributed');
  }
  return { width: buffer.readUInt32BE(Number('16')), height: buffer.readUInt32BE(Number('20')) };
}

export function captureKeyPrefix(artifactPrefix) {
  return artifactPrefix.slice(CAPTURE_ARTIFACT_ROOT.length);
}

export async function uploadCaptureObject(keyPrefix, name, body, contentType) {
  return putPrivateStadoObject(CAPTURE_NAMESPACE, `${keyPrefix}${name}`, body, contentType);
}
