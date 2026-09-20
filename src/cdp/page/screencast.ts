/**
 * CDP screencast-based video recording.
 *
 * Uses Page.startScreencast to capture PNG frames, then stitches them into
 * a .webm video with ffmpeg when recording stops.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../session/run-recordings.js';
import { resolveMediaTool } from '../../runtime/media-tools.js';
import type { CDPConnection } from '../connection.js';

export class CDPVideo {
  _path: string | null = null;
  async path(): Promise<string | null> { return this._path; }
}

export class CDPScreencast {
  private _conn: CDPConnection;
  private _sid: string;
  private _everyNth: number;
  private _frameDir: string;
  private _outputDir: string;
  private _frameCount = 0;
  private _started = false;
  _stopped = false;
  video = new CDPVideo();
  private _listener: (params: any) => void;

  /**
   * The frames used to be written into `$TMPDIR`, and on 2026-09-20 that is
   * where a recording of app.wisent.com died: 5,355 frames were captured and
   * ffmpeg then answered `Error opening input: No such file or directory` for
   * the very directory they had been written to. macOS empties a user's
   * `/var/folders` temporary area under disk pressure, which is exactly the
   * state a host is in when a recording matters, and nothing in this product
   * owns that directory.
   *
   * Frames now live beside the video they become, inside the run's own
   * recordings directory: the store this worker owns, the one its budget
   * prunes, and the one its evidence is read from. They are removed once the
   * WebM exists.
   */
  constructor(conn: CDPConnection, sessionId: string, options?: { outputDir?: string; everyNthFrame?: number }) {
    this._conn = conn;
    this._sid = sessionId;
    this._everyNth = options?.everyNthFrame ?? 2;
    this._outputDir = options?.outputDir ?? runRecordingsDir('screencast');
    this._frameDir = mkdtempSync(join(this._outputDir, 'frames_'));
    this._listener = (params: any) => this._onFrame(params);
  }

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    this._conn.on('Page.screencastFrame', this._listener, this._sid);
    await this._conn.send('Page.startScreencast', {
      format: 'png', everyNthFrame: this._everyNth,
    }, this._sid);
  }

  private _onFrame(params: any): void {
    const sessionId = params.sessionId ?? 0;
    const data: string = params.data ?? '';
    if (!data) return;
    this._frameCount++;
    const framePath = join(this._frameDir, `frame_${String(this._frameCount).padStart(6, '0')}.png`);
    writeFileSync(framePath, Buffer.from(data, 'base64'));
    this._conn.send('Page.screencastFrameAck', { sessionId }, this._sid).catch(() => {});
  }

  async stop(): Promise<string | null> {
    if (this._stopped) return this.video._path;
    this._stopped = true;
    try { await this._conn.send('Page.stopScreencast', undefined, this._sid); } catch { /* target closed */ }
    this._conn.off('Page.screencastFrame', this._listener, this._sid);
    if (this._frameCount === 0) return null;
    const videoPath = this._stitch();
    // The frames are the video's raw material, not evidence of their own,
    // and they are large: a ninety-second capture leaves several thousand
    // PNGs beside the WebM they became.
    rmSync(this._frameDir, { recursive: true, force: true });
    this.video._path = videoPath;
    return videoPath;
  }

  /**
   * Stitch the captured frames into one WebM, or say exactly why not.
   *
   * This used to shell out to a bare `ffmpeg` and return an empty string on
   * any failure, so a worker whose PATH does not carry ffmpeg — which is
   * every launchd-managed worker on a Homebrew host — reported the same
   * nothing as a browser that sent no frames. The binary is resolved by
   * path now, and ffmpeg's own stderr is what a failure carries.
   */
  private _stitch(): string {
    mkdirSync(this._outputDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '_');
    const outPath = join(this._outputDir, `screencast_${ts}.webm`);
    const pattern = join(this._frameDir, 'frame_%06d.png');
    const ffmpeg = resolveMediaTool('ffmpeg');
    try {
      execFileSync(ffmpeg, [
        '-y', '-framerate', '5', '-i', pattern,
        '-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '1M', outPath,
      ], { encoding: 'utf-8', stdio: 'pipe', timeout: Number('300000') });
    } catch (error) {
      const captured = error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr ?? '').trim()
        : '';
      const cause = captured || (error instanceof Error ? error.message : String(error));
      throw new Error(
        `${ffmpeg} could not stitch ${this._frameCount} frame(s) from ${this._frameDir} `
        + `into ${outPath}: ${cause.slice(-Number('600'))}`,
        { cause: error },
      );
    }
    return outPath;
  }
}
