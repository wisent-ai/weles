import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mediaToolCandidates, resolveMediaTool } from '../../../../dist/runtime/media-tools.js';

const FPS = 25;

function recordingError(code, operation, detail, state = {}, cause) {
  return Object.assign(new Error(`${operation}: ${detail}`, { cause }), { code, operation, ...state });
}

export function captureVideoTools() {
  const candidates = mediaToolCandidates('ffmpeg');
  const pinned = process.env.WELES_FFMPEG_BIN?.trim();
  const encoder = pinned || candidates.find((candidate) => existsSync(candidate));
  if (!encoder || !existsSync(encoder)) {
    throw recordingError('CAPTURE_ENCODER_UNAVAILABLE', 'resolve_capture_encoder',
      `no ffmpeg at the selected path; candidates=${candidates.join(', ')}`, { encoder: encoder ?? null });
  }
  // The recorder streams JPEGs through image2pipe, not the disk-sequence
  // demuxer required by the separate CDP frame-stitching path.
  try {
    return { encoder, probe: resolveMediaTool('ffprobe') };
  } catch (cause) {
    throw recordingError('CAPTURE_PROBE_UNAVAILABLE', 'resolve_capture_probe',
      cause.message, { probe: process.env.WELES_FFPROBE_BIN?.trim() || null }, cause);
  }
}

function inspectVideo(path, probe, minimumSeconds) {
  let result;
  try {
    result = JSON.parse(execFileSync(probe, [
      '-v', 'error', '-select_streams', 'v:0', '-count_frames',
      '-show_entries', 'stream=width,height,nb_read_frames:format=duration',
      '-of', 'json', path,
    ], { encoding: 'utf8' }));
  } catch (cause) {
    throw recordingError('CAPTURE_VIDEO_PROBE_FAILED', 'inspect_capture_video',
      cause.message, { path, probe, stderr: String(cause.stderr ?? '') }, cause);
  }
  const stream = result.streams?.[0];
  const width = stream?.width;
  const height = stream?.height;
  const frames = Number(stream?.nb_read_frames);
  const duration = Number(result.format?.duration);
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0
      || !Number.isSafeInteger(frames) || frames <= 0 || !Number.isFinite(duration) || duration < minimumSeconds) {
    throw recordingError('CAPTURE_VIDEO_INCOMPLETE', 'inspect_capture_video',
      'the decoded file does not contain the requested recording',
      { path, requestedSeconds: minimumSeconds, observed: result });
  }
  return { path, width, height, frames, duration_seconds: duration };
}

/** Record actual viewport captures while perform runs, then complete the media
 * duration. The browser is observed even when the page is static. Repeating the
 * previous captured frame between observations preserves real capture spacing;
 * no invented animation or fixed-duration page pause supplies those frames.
 * closeSession must close this run's session, so a failed encoder or capture
 * also releases a pending browser action before this function returns.
 */
export async function recordCaptureVideo({ page, path, seconds, tools, perform, closeSession }) {
  const minimumFrames = Math.ceil(seconds * FPS);
  if (!Number.isSafeInteger(minimumFrames) || minimumFrames <= 0) {
    throw recordingError('CAPTURE_DURATION_UNREPRESENTABLE', 'start_capture_recording',
      'the requested duration cannot be represented as a positive frame count', { requestedSeconds: seconds });
  }
  const args = [
    '-loglevel', 'error', '-f', 'image2pipe', '-avioflags', 'direct',
    '-fpsprobesize', '0', '-probesize', '32', '-analyzeduration', '0',
    '-c:v', 'mjpeg', '-r', String(FPS), '-i', 'pipe:0',
    '-y', '-an', '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '1M', path,
  ];
  const encoder = spawn(tools.encoder, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  let stderr = '';
  let failure = null;
  let cleanup = null;
  let actionsDone = false;
  let inputEnded = false;
  let writtenFrames = 0;
  const fail = (error) => {
    if (!failure) {
      failure = error;
      encoder.stdin.destroy();
      cleanup = Promise.resolve().then(closeSession).catch((closeError) => {
        failure = new AggregateError([error, closeError], 'Capture and session cleanup failed');
      });
    }
  };
  encoder.stderr.setEncoding('utf8');
  encoder.stderr.on('data', (chunk) => { stderr += chunk; });
  encoder.stdin.on('error', (cause) => fail(recordingError(
    'CAPTURE_ENCODER_INPUT_FAILED', 'write_capture_frame', cause.message,
    { encoder: tools.encoder, path, writtenFrames, stderr }, cause,
  )));
  const exited = new Promise((resolve) => {
    encoder.once('error', (cause) => fail(recordingError(
      'CAPTURE_ENCODER_START_FAILED', 'start_capture_encoder', cause.message,
      { encoder: tools.encoder, path }, cause,
    )));
    encoder.once('close', (status, signal) => {
      if (status !== 0 || signal || !inputEnded) fail(recordingError(
        'CAPTURE_ENCODER_FAILED', 'encode_capture_video', `exit=${status} signal=${signal ?? 'none'} inputEnded=${inputEnded}; ${stderr.trim()}`,
        { encoder: tools.encoder, path, status, signal, writtenFrames, inputEnded, stderr },
      ));
      resolve();
    });
  });
  const writeFrame = (frame) => new Promise((resolve, reject) => {
    encoder.stdin.write(frame, (error) => error ? reject(error) : resolve());
  });
  const capture = (async () => {
    let previous = await page.screenshot({ type: 'jpeg', quality: 80 });
    const firstFrameAt = process.hrtime.bigint();
    for (;;) {
      if (failure) throw failure;
      const frame = await page.screenshot({ type: 'jpeg', quality: 80 });
      const elapsed = Number(process.hrtime.bigint() - firstFrameAt) / 1e9;
      const frameCount = Math.floor(elapsed * FPS) + 1;
      while (writtenFrames < frameCount) {
        if (failure) throw failure;
        await writeFrame(previous);
        writtenFrames += 1;
      }
      previous = frame;
      if (actionsDone && writtenFrames >= minimumFrames) break;
    }
    inputEnded = true;
    encoder.stdin.end();
  })().catch(fail);
  const actions = (async () => {
    if (failure) throw failure;
    await perform();
    actionsDone = true;
  })().catch(fail);
  await Promise.all([capture, actions, exited]);
  if (cleanup) await cleanup;
  if (failure) throw failure;
  return inspectVideo(path, tools.probe, seconds);
}
