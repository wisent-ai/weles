import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mediaToolCandidates } from '../../../../dist/runtime/media-tools.js';

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
  return { encoder };
}

async function inspectVideo(context, path, minimumSeconds) {
  let inspector;
  let result;
  let failure;
  try {
    // Inspect the written file with the managed browser's actual WebM decoder.
    // This isolated page never alters the product page being captured, and
    // needs no ffprobe binary absent from the managed browser runtime.
    inspector = await context.newPage();
    await inspector.setContent('<input id="capture-file" type="file" accept="video/webm">');
    await inspector.locator('#capture-file').setInputFiles(path);
    result = await inspector.evaluate(() => new Promise((resolve, reject) => {
      const file = document.querySelector('#capture-file').files[0];
      if (!file) { reject(new Error('The recording file was not attached')); return; }
      const video = document.createElement('video');
      const source = URL.createObjectURL(file);
      video.preload = 'auto';
      video.muted = true;
      video.addEventListener('error', () => {
        const error = video.error;
        URL.revokeObjectURL(source);
        reject(new Error(`WebM decode failed: code=${error?.code} message=${error?.message}`));
      }, { once: true });
      video.addEventListener('loadeddata', () => {
        const observed = {
          width: video.videoWidth, height: video.videoHeight,
          duration_seconds: video.duration, ready_state: video.readyState, bytes: file.size,
        };
        URL.revokeObjectURL(source);
        resolve(observed);
      }, { once: true });
      document.body.append(video);
      video.src = source;
      video.load();
    }));
    if (!Number.isSafeInteger(result.width) || result.width <= 0
        || !Number.isSafeInteger(result.height) || result.height <= 0
        || !Number.isFinite(result.duration_seconds) || result.duration_seconds < minimumSeconds) {
      throw recordingError('CAPTURE_VIDEO_INCOMPLETE', 'inspect_capture_video',
        'the written file does not contain the requested recording',
        { path, requestedSeconds: minimumSeconds, observed: result });
    }
  } catch (cause) {
    failure = cause.code === 'CAPTURE_VIDEO_INCOMPLETE' ? cause
      : recordingError('CAPTURE_VIDEO_PROBE_FAILED', 'inspect_capture_video',
        cause.message, { path }, cause);
  } finally {
    if (inspector) {
      try { await inspector.close(); }
      catch (cause) {
        failure = failure ? new AggregateError([failure, cause], 'Video inspection and cleanup failed') : cause;
      }
    }
  }
  if (failure) throw failure;
  return { path, ...result };
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
  return { ...await inspectVideo(page.context(), path, seconds), frames_submitted: writtenFrames };
}
