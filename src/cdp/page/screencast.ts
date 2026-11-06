/**
 * CDP screencast-based video recording.
 *
 * Uses Page.startScreencast to capture PNG frames, then stitches them into
 * a .webm video with ffmpeg when recording stops. Each frame is held on
 * screen for as long as it was on the page: the time until the next frame
 * arrived, measured as it arrived, so the video plays at the page's own pace.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { runRecordingsDir } from '../../session/run-recordings.js';
import { resolveMediaTool } from '../../runtime/media-tools.js';
import type { CDPConnection } from '../connection.js';

export class CDPVideo {
  _path: string | null = null;
  async path(): Promise<string | null> {
    return this._path;
  }
}

/** One captured frame: its file, and when it arrived (performance.now(), milliseconds). */
export type CapturedFrame = { file: string; arrivedAt: number };

/** The Page.screencastFrame event as CDP sends it (https://chromedevtools.github.io/devtools-protocol/tot/Page/#event-screencastFrame). */
type ScreencastFrame = { data?: unknown; sessionId?: unknown };

export class CDPScreencast {
  private _conn: CDPConnection;
  private _sid: string;
  private _everyNth: number | undefined;
  private _frameDir: string;
  private _outputDir: string;
  private _frames: CapturedFrame[] = [];
  private _started = false;
  _stopped = false;
  video = new CDPVideo();
  private _listener: (params: ScreencastFrame) => void;

  /**
   * Frames live inside the run's own recordings directory, beside the video
   * they become: the store this worker owns, the one its budget prunes, and
   * the one its evidence is read from. They are removed once the WebM exists.
   * Without everyNthFrame, Chrome sends every frame it paints.
   */
  constructor(
    conn: CDPConnection,
    sessionId: string,
    options?: { outputDir?: string; everyNthFrame?: number },
  ) {
    this._conn = conn;
    this._sid = sessionId;
    this._everyNth = options?.everyNthFrame;
    this._outputDir = options?.outputDir ?? runRecordingsDir('screencast');
    this._frameDir = mkdtempSync(join(this._outputDir, 'frames_'));
    this._listener = (params) => this._onFrame(params);
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this._conn.on('Page.screencastFrame', this._listener, this._sid);
    await this._conn.send(
      'Page.startScreencast',
      this._everyNth === undefined
        ? { format: 'png' }
        : { format: 'png', everyNthFrame: this._everyNth },
      this._sid,
    );
  }

  private _onFrame(params: ScreencastFrame): void {
    if (typeof params.data !== 'string' || !params.data) {
      console.error(
        `[cdp] screencast frame of session ${this._sid} carried no image data; it is not recorded`,
      );
      return;
    }
    const file = join(this._frameDir, `frame_${this._frames.length}.png`);
    writeFileSync(file, Buffer.from(params.data, 'base64'));
    this._frames.push({ file, arrivedAt: performance.now() });
    // Chrome sends no further frame until this one is acknowledged, so an
    // acknowledgement that fails ends the recording early; that is said.
    if (typeof params.sessionId !== 'number') {
      console.error(
        `[cdp] screencast frame ${this._frames.length} of session ${this._sid} carried no sessionId to acknowledge; the recording stops here`,
      );
      return;
    }
    this._conn
      .send(
        'Page.screencastFrameAck',
        { sessionId: params.sessionId },
        this._sid,
      )
      .catch((error) => {
        if (this._stopped) return;
        console.error(
          `[cdp] screencast frame ${this._frames.length} in ${this._frameDir} was not acknowledged; the recording may stop here: ${error}`,
        );
      });
  }

  async stop(): Promise<string | null> {
    if (this._stopped) return this.video._path;
    this._stopped = true;
    const stoppedAt = performance.now();
    try {
      await this._conn.send('Page.stopScreencast', undefined, this._sid);
    } catch (error) {
      // A closed target ends its screencast by closing; the frames already
      // captured are still stitched, and the refusal is said.
      console.error(
        `[cdp] Page.stopScreencast for session ${this._sid} failed; stitching the ${this._frames.length} frames already captured: ${error}`,
      );
    }
    this._conn.off('Page.screencastFrame', this._listener, this._sid);
    if (!this._frames.length) return null;
    let videoPath: string;
    try {
      videoPath = stitchFrames(
        this._frames,
        stoppedAt,
        this._frameDir,
        this._outputDir,
      );
    } catch (error) {
      // Page close is the one caller and closes the target regardless, so
      // the recording's loss and its cause are said here, with the frames
      // left in place for a later stitch.
      console.error(
        `[async_api] recording of session ${this._sid} could not be stitched; its frames stay in ${this._frameDir}: ${error}`,
      );
      throw error;
    }
    // The frames are the video's raw material, not evidence of their own,
    // and they are large.
    rmSync(this._frameDir, { recursive: true, force: true });
    this.video._path = videoPath;
    return videoPath;
  }
}

/**
 * The ffmpeg concat list of `frames`: each file shown until the next frame
 * arrived, the last until `endedAt`. The concat demuxer reads a duration per
 * file and, for the last one to be held, the file named once more
 * (https://ffmpeg.org/ffmpeg-formats.html#concat-1).
 */
function concatList(frames: CapturedFrame[], endedAt: number): string {
  const quoted = (frame: CapturedFrame) =>
    `file '${frame.file.replaceAll("'", "'\\''")}'`;
  // `later[index]` is the frame that followed `frames[index]`.
  const [, ...later] = frames;
  const lines = frames.flatMap((frame, index) => {
    const next = later[index];
    const until = next ? next.arrivedAt : endedAt;
    return [
      quoted(frame),
      `duration ${Math.max(until - frame.arrivedAt, Number())}ms`,
    ];
  });
  const last = [...frames].pop();
  if (last) lines.push(quoted(last));
  return `${lines.join('\n')}\n`;
}

/**
 * Turn captured frames into one WebM at the pace they arrived, or say why not.
 * The binary is resolved by path and ffmpeg's own stderr is what a failure
 * carries.
 */
export function stitchFrames(
  frames: CapturedFrame[],
  endedAt: number,
  frameDir: string,
  outputDir: string,
): string {
  mkdirSync(outputDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '_');
  const outPath = join(outputDir, `screencast_${ts}.webm`);
  const listPath = join(frameDir, 'frames.txt');
  writeFileSync(listPath, concatList(frames, endedAt));
  const ffmpeg = resolveMediaTool('ffmpeg');
  try {
    // safe 0 admits the absolute frame paths the list names; libvpx with
    // yuv420p is the pixel format browsers decode in a WebM.
    execFileSync(
      ffmpeg,
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listPath,
        '-c:v',
        'libvpx',
        '-pix_fmt',
        'yuv420p',
        outPath,
      ],
      {
        encoding: 'utf-8',
        stdio: 'pipe',
      },
    );
  } catch (error) {
    const captured =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : '';
    throw new Error(
      `${ffmpeg} could not stitch ${frames.length} frame(s) from ${frameDir} into ${outPath}: ${captured ? captured : error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return outPath;
}
