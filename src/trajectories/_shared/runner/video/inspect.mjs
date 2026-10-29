// Reading back a capture recording once it is written: the managed browser's
// own WebM decoder opens the file in an isolated page and reports its size and
// duration, and a recording shorter than requested is refused. The named
// failure every capture step raises is built here too.

/** A capture failure carrying its code, the operation that met it and the state observed. */
export function recordingError(code, operation, detail, state = {}, cause) {
  return Object.assign(new Error(`${operation}: ${detail}`, { cause }), {
    code,
    operation,
    ...state,
  });
}

export async function inspectVideo(context, path, minimumSeconds) {
  let inspector;
  let result;
  let failure;
  try {
    // Inspect the written file with the managed browser's actual WebM decoder.
    // This isolated page never alters the product page being captured, and
    // needs no ffprobe binary absent from the managed browser runtime.
    inspector = await context.newPage();
    await inspector.setContent(
      '<input id="capture-file" type="file" accept="video/webm">',
    );
    await inspector.locator('#capture-file').setInputFiles(path);
    result = await inspector.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const file = document.querySelector('#capture-file').files[0];
          if (!file) {
            reject(new Error('The recording file was not attached'));
            return;
          }
          const video = document.createElement('video');
          const source = URL.createObjectURL(file);
          video.preload = 'auto';
          video.muted = true;
          video.addEventListener(
            'error',
            () => {
              const error = video.error;
              URL.revokeObjectURL(source);
              reject(
                new Error(
                  `WebM decode failed: code=${error?.code} message=${error?.message}`,
                ),
              );
            },
            { once: true },
          );
          video.addEventListener(
            'loadeddata',
            () => {
              const observed = {
                width: video.videoWidth,
                height: video.videoHeight,
                duration_seconds: video.duration,
                ready_state: video.readyState,
                bytes: file.size,
              };
              URL.revokeObjectURL(source);
              resolve(observed);
            },
            { once: true },
          );
          document.body.append(video);
          video.src = source;
          video.load();
        }),
    );
    if (
      !Number.isSafeInteger(result.width) ||
      result.width <= 0 ||
      !Number.isSafeInteger(result.height) ||
      result.height <= 0 ||
      !Number.isFinite(result.duration_seconds) ||
      result.duration_seconds < minimumSeconds
    ) {
      throw recordingError(
        'CAPTURE_VIDEO_INCOMPLETE',
        'inspect_capture_video',
        'the written file does not contain the requested recording',
        { path, requestedSeconds: minimumSeconds, observed: result },
      );
    }
  } catch (cause) {
    failure =
      cause.code === 'CAPTURE_VIDEO_INCOMPLETE'
        ? cause
        : recordingError(
            'CAPTURE_VIDEO_PROBE_FAILED',
            'inspect_capture_video',
            cause.message,
            { path },
            cause,
          );
  } finally {
    if (inspector) {
      try {
        await inspector.close();
      } catch (cause) {
        failure = failure
          ? new AggregateError(
              [failure, cause],
              'Video inspection and cleanup failed',
            )
          : cause;
      }
    }
  }
  if (failure) throw failure;
  return { path, ...result };
}
