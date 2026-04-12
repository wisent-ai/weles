/**
 * CDP screencast-based video recording.
 *
 * Uses Page.startScreencast to capture PNG frames, then stitches them into
 * a .webm video with ffmpeg when recording stops.
 */

import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

  constructor(conn: CDPConnection, sessionId: string, options?: { outputDir?: string; everyNthFrame?: number }) {
    this._conn = conn;
    this._sid = sessionId;
    this._everyNth = options?.everyNthFrame ?? 2;
    this._frameDir = mkdtempSync(join(tmpdir(), 'weles_screencast_'));
    this._outputDir = options?.outputDir ?? mkdtempSync(join(tmpdir(), 'weles_video_'));
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
    this.video._path = videoPath;
    return videoPath;
  }

  private _stitch(): string {
    mkdirSync(this._outputDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '_');
    const outPath = join(this._outputDir, `screencast_${ts}.webm`);
    const pattern = join(this._frameDir, 'frame_%06d.png');
    try {
      execSync(`ffmpeg -y -framerate 5 -i ${JSON.stringify(pattern)} -c:v libvpx -pix_fmt yuv420p -b:v 1M ${JSON.stringify(outPath)}`, {
        encoding: 'utf-8', stdio: 'pipe',
      });
      return outPath;
    } catch {
      return '';
    }
  }
}
