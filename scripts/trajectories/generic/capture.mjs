/**
 * generic_capture — one attributed capture of one product surface.
 *
 * Params arrive as GENERIC_CAPTURE_PLAN (dispatch already parsed and refused
 * malformed rows; the same parser runs again here so a hand-started run cannot
 * skip the contract). The run navigates to source_url in the patched Chromium on
 * the Stado-selected host, applies the viewport, executes the scripted steps in
 * order, and writes:
 *
 *   <base>.png        the still (viewport or full page)
 *   <base>.png.json   its sidecar
 *   <base>.webm       the screencast, only when record_seconds > 0
 *   <base>.webm.json  its sidecar
 *
 * <base> encodes site, axis, viewport, full-page flag and a digest of
 * (source_url, steps, record_seconds), so the several captures a site+axis
 * prefix holds never collide.
 *
 * Everything is uploaded to artifact_prefix through Stado product objects. An
 * upload that does not come back acknowledged fails the action — an artifact
 * left on the host is not evidence.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CDPScreencast } from '../../../dist/cdp/page/screencast.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { parseCaptureParams } from '../../../dist/worker/capture-params.js';
import { humanHoverDwell, humanScroll } from '../../../dist/human/mouse.js';
import {
  captureKeyPrefix, fileAttribution, planFromEnv, pngPixelSize, screencastConnection,
  startCaptureSession, uploadCaptureObject, welesVersion, writeLocalArtifact,
} from '../_shared/capture-runtime.mjs';

const label = 'generic_capture';
const STEP_TIMEOUT_MS = Number('30000');

async function runStep(session, step) {
  if (step.op === 'wait_selector') {
    const outcome = await session.waitFor(step.value, { timeoutMs: STEP_TIMEOUT_MS });
    if (outcome.startsWith('wait failed')) throw new Error(`step wait_selector ${JSON.stringify(step.value)} never became visible`);
    return outcome;
  }
  if (step.op === 'click') {
    const outcome = await session.clickSelector(step.value);
    if (outcome === 'no-element-found') throw new Error(`step click ${JSON.stringify(step.value)} matched no element`);
    return outcome;
  }
  if (step.op === 'hover') {
    const hovered = await humanHoverDwell(session.page, session.page.locator(step.value).first(), { minMs: 700, maxMs: 1200, leave: false });
    if (!hovered) throw new Error(`step hover ${JSON.stringify(step.value)} matched no visible element`);
    return `hovered ${step.value}`;
  }
  if (step.op === 'focus') {
    const outcome = await session.focus(step.value);
    if (outcome === 'no-element-found') throw new Error(`step focus ${JSON.stringify(step.value)} matched no element`);
    return outcome;
  }
  if (step.op === 'press') return session.press(step.value);
  if (step.op === 'scroll') {
    await humanScroll(session.page, Number(step.value || '1200'));
    return `scrolled ${step.value || '1200'}`;
  }
  if (step.op === 'wait_ms') {
    await session.page.waitForTimeout(Number(step.value || '1000'));  // allow-raw-playwright: the plan asked for an explicit settle pause
    return `waited ${step.value || '1000'}ms`;
  }
  return session.goto(step.value);
}

// ffprobe ships with the ffmpeg the screencast already stitches with. The video's
// real pixel size and duration come from the file, not from what we asked for.
function probeVideo(path) {
  const raw = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json', path,
  ], { encoding: 'utf8', timeout: Number('30000') });
  const parsed = JSON.parse(raw);
  const stream = parsed.streams?.[0] ?? {};
  const duration = Number(parsed.format?.duration);
  if (!stream.width || !stream.height) throw new Error(`ffprobe reported no video stream for ${path}`);
  return {
    width: Number(stream.width),
    height: Number(stream.height),
    duration_seconds: Number.isFinite(duration) ? Math.round(duration * 1000) / 1000 : null,
  };
}

const plan = planFromEnv('GENERIC_CAPTURE_PLAN', parseCaptureParams);
const keyPrefix = captureKeyPrefix(plan.artifact_prefix);
const signature = createHash('sha256')
  .update(JSON.stringify({ source_url: plan.source_url, steps: plan.steps, record_seconds: plan.record_seconds }))
  .digest('hex')
  .slice(Number('0'), Number('8'));
const base = [
  plan.site_slug,
  plan.axis,
  `${plan.viewport.width}x${plan.viewport.height}@${plan.viewport.device_scale_factor}x`,
  ...(plan.full_page ? ['fullpage'] : []),
  signature,
].join('--');

let started = null;
let screencast = null;
const stepsExecuted = [];
const artifacts = [];
try {
  console.log(`[capture] ${plan.batch}/${plan.site_slug}/${plan.axis} url=${plan.source_url} viewport=${plan.viewport.width}x${plan.viewport.height}@${plan.viewport.device_scale_factor}x full_page=${plan.full_page} record=${plan.record_seconds}s steps=${plan.steps.length}`);
  started = await startCaptureSession(label, plan);
  const { session, cdp, renderer } = started;
  const version = welesVersion();
  await session.goto(plan.source_url);
  await session.page.waitForLoadState('load').catch(() => {});

  const recordStartedAt = Date.now();
  if (plan.record_seconds > 0) {
    screencast = new CDPScreencast(screencastConnection(cdp), '', { outputDir: runRecordingsDir(label), everyNthFrame: 1 });
    await screencast.start();
  }
  for (const step of plan.steps) {
    const outcome = await runStep(session, step);
    stepsExecuted.push({ op: step.op, value: step.value, outcome: String(outcome).slice(Number('0'), Number('200')) });
  }
  // The recording covers the scripted interaction and nothing else: it is sealed
  // before the still is taken, so a full-page screenshot's scroll/resize never
  // ends up in the video and the still is never a frame of it.
  let videoPath = null;
  if (screencast) {
    const remainingMs = plan.record_seconds * 1000 - (Date.now() - recordStartedAt);
    if (remainingMs > 0) await session.page.waitForTimeout(remainingMs);  // allow-raw-playwright: hold the recording open for the requested duration
    videoPath = await screencast.stop();
    if (!videoPath) throw new Error(`record_seconds ${plan.record_seconds} produced no video: the screencast captured no frames or ffmpeg could not stitch them`);
  }

  const capturedAt = new Date().toISOString();
  const stillBuffer = await session.page.screenshot({ fullPage: plan.full_page, type: 'png' });
  const stillPath = writeLocalArtifact(label, `${base}.png`, stillBuffer);
  const still = fileAttribution(stillPath);
  const stillSize = pngPixelSize(still.buffer);
  const stillSidecar = {
    source_url: plan.source_url,
    axis: plan.axis,
    viewport: plan.viewport,
    full_page: plan.full_page,
    steps_executed: stepsExecuted,
    captured_at: capturedAt,
    renderer,
    weles_version: version,
    media_kind: 'still-png',
    width: stillSize.width,
    height: stillSize.height,
    duration_seconds: null,
    bytes: still.bytes,
    sha256: still.sha256,
    capture_method: `Rendered ${plan.source_url} in ${renderer} on the Stado-selected Weles host at ${plan.viewport.width}x${plan.viewport.height} CSS px and device scale factor ${plan.viewport.device_scale_factor}, executed ${stepsExecuted.length} scripted step(s), then captured ${plan.full_page ? 'a full-page' : 'a viewport'} PNG through CDP Page.captureScreenshot.`,
  };
  artifacts.push({
    key: `${keyPrefix}${base}.png`,
    uri: await uploadCaptureObject(keyPrefix, `${base}.png`, still.buffer, 'image/png'),
    sidecar_key: `${keyPrefix}${base}.png.json`,
    sidecar_uri: await uploadCaptureObject(keyPrefix, `${base}.png.json`, JSON.stringify(stillSidecar, null, 2), 'application/json'),
    media_kind: 'still-png',
    bytes: still.bytes,
    sha256: still.sha256,
  });

  if (videoPath) {
    const video = fileAttribution(videoPath);
    const probed = probeVideo(videoPath);
    const videoSidecar = {
      source_url: plan.source_url,
      axis: plan.axis,
      viewport: plan.viewport,
      full_page: plan.full_page,
      steps_executed: stepsExecuted,
      captured_at: capturedAt,
      renderer,
      weles_version: version,
      media_kind: 'video-webm',
      width: probed.width,
      height: probed.height,
      duration_seconds: probed.duration_seconds,
      bytes: video.bytes,
      sha256: video.sha256,
      capture_method: `Recorded ${plan.source_url} in ${renderer} on the Stado-selected Weles host for ${plan.record_seconds}s at ${plan.viewport.width}x${plan.viewport.height} CSS px and device scale factor ${plan.viewport.device_scale_factor} while executing ${stepsExecuted.length} scripted step(s), capturing CDP Page.startScreencast PNG frames stitched into WebM with ffmpeg.`,
    };
    artifacts.push({
      key: `${keyPrefix}${base}.webm`,
      uri: await uploadCaptureObject(keyPrefix, `${base}.webm`, video.buffer, 'video/webm'),
      sidecar_key: `${keyPrefix}${base}.webm.json`,
      sidecar_uri: await uploadCaptureObject(keyPrefix, `${base}.webm.json`, JSON.stringify(videoSidecar, null, 2), 'application/json'),
      media_kind: 'video-webm',
      bytes: video.bytes,
      sha256: video.sha256,
    });
  }

  writeFileSync(join(runRecordingsDir(label), 'capture_result.json'), JSON.stringify({
    ok: true,
    batch: plan.batch,
    site_slug: plan.site_slug,
    axis: plan.axis,
    source_url: plan.source_url,
    artifact_prefix: plan.artifact_prefix,
    artifacts,
    steps_executed: stepsExecuted,
    renderer,
    weles_version: version,
    completed_at: new Date().toISOString(),
  }, null, 2));
  console.log(`PASS: ${label} ${artifacts.map((artifact) => artifact.uri).join(' ')}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (screencast && !screencast._stopped) await screencast.stop().catch(() => {});
  writeFileSync(join(runRecordingsDir(label), 'capture_result.json'), JSON.stringify({
    ok: false,
    batch: plan.batch,
    site_slug: plan.site_slug,
    axis: plan.axis,
    source_url: plan.source_url,
    artifact_prefix: plan.artifact_prefix,
    artifacts,
    steps_executed: stepsExecuted,
    error: message,
    completed_at: new Date().toISOString(),
  }, null, 2));
  console.log('FAIL:', message.slice(Number('0'), Number('300')));
  process.exitCode = 1;
} finally {
  if (started) await started.session.close();
}

process.exit(process.exitCode ?? 0);
