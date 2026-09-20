/**
 * The step that turns captured frames into a recording.
 *
 * It had never worked. Frames are written `frame_000001.png` upward and
 * ffmpeg's image demuxer begins at `frame_000000.png`, so every capture this
 * product ever ran answered `Error opening input: No such file or directory`
 * and reported no video — most recently throwing away 4,528 recorded frames
 * of app.wisent.com on 2026-09-20.
 *
 * This case hands the real stitch real PNG frames on disk and requires a
 * real WebM with bytes in it back. No browser, no mock, the host's own
 * ffmpeg. Its fixture lives in the package's ignored build directory.
 */

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { stitchFrames } from '../../dist/cdp/page/screencast.js';
import { resolveMediaTool } from '../../dist/runtime/media-tools.js';

/** The package's own ignored build area; removed when the case ends. */
const ROOT = join(process.cwd(), '.build', `stitch-${process.pid}`);

/** Enough frames that the sequence, not a single image, is what is read. */
const FRAME_COUNT = Number('3');

function writeFrames(directory) {
  mkdirSync(directory, { recursive: true });
  const ffmpeg = resolveMediaTool('ffmpeg');
  for (let index = 1; index <= FRAME_COUNT; index += 1) {
    const name = `frame_${String(index).padStart(Number('6'), '0')}.png`;
    execFileSync(ffmpeg, [
      '-y', '-f', 'lavfi', '-i', `color=c=black:s=64x64:d=1`,
      '-frames:v', '1', join(directory, name),
    ]);
  }
}

test('real frames become a real WebM', () => {
  const frames = join(ROOT, 'frames');
  const output = join(ROOT, 'out');
  try {
    writeFrames(frames);
    const video = stitchFrames(frames, output, FRAME_COUNT);
    assert.match(video, /\.webm$/, `the stitch must name a WebM, got ${video}`);
    const written = statSync(video);
    assert.ok(
      written.size > Number('0'),
      `the stitch wrote an empty file at ${video}`,
    );
  } finally {
    rmSync(ROOT, { recursive: true, force: true });
  }
});

test('a frame sequence that starts at one is found', () => {
  const frames = join(ROOT, 'frames-one');
  const output = join(ROOT, 'out-one');
  try {
    writeFrames(frames);
    // The regression itself: the first frame is number one, and a demuxer
    // told to start at zero reports the whole directory missing.
    const video = stitchFrames(frames, output, FRAME_COUNT);
    assert.ok(statSync(video).size > Number('0'));
  } finally {
    rmSync(ROOT, { recursive: true, force: true });
  }
});
