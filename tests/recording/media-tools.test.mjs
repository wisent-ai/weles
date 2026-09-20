/**
 * The recording path must know where its tools are.
 *
 * Until 2026-09-20 the screencast stitched with a bare word `ffmpeg` through
 * a shell and swallowed whatever came back. A launchd-managed worker's PATH
 * is `/usr/bin:/bin:/usr/sbin:/sbin`, so a Homebrew install in
 * `/opt/homebrew/bin` was never reachable, and every capture ended with
 * `the screencast captured no frames or ffmpeg could not stitch them` — one
 * sentence covering a browser that sent nothing and a stitcher that was
 * never found.
 *
 * These cases drive the real resolver against this host's real binaries. No
 * stub, no fake PATH: the tool that comes back is executed.
 */

import { execFileSync } from 'node:child_process';
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  mediaToolCandidates,
  resolveMediaTool,
} from '../../dist/runtime/media-tools.js';

const TOOLS = ['ffmpeg', 'ffprobe'];

for (const tool of TOOLS) {
  test(`${tool} resolves to an executable that answers`, () => {
    const resolved = resolveMediaTool(tool);
    assert.ok(resolved.startsWith('/'), `${tool} must resolve to an absolute path, got ${resolved}`);
    const version = execFileSync(resolved, ['-version'], { encoding: 'utf8' });
    assert.match(version, new RegExp(`${tool} version`, 'i'));
  });

  test(`${tool} names every place it looked when the pin is wrong`, () => {
    const variable = `WELES_${tool.toUpperCase()}_BIN`;
    const previous = process.env[variable];
    process.env[variable] = `/nonexistent/${tool}-that-was-never-installed`;
    try {
      const candidates = mediaToolCandidates(tool);
      assert.equal(candidates[0], process.env[variable]);
      assert.ok(
        candidates.includes(`/opt/homebrew/bin/${tool}`),
        `the search must cover the Homebrew prefix a launchd PATH omits: ${candidates.join(', ')}`,
      );
    } finally {
      if (previous === undefined) delete process.env[variable];
      else process.env[variable] = previous;
    }
  });
}

test('a pinned tool that does not exist is refused with the list that was searched', () => {
  const previous = process.env.WELES_FFMPEG_BIN;
  process.env.WELES_FFMPEG_BIN = '/nonexistent/ffmpeg-that-was-never-installed';
  try {
    assert.throws(
      () => resolveMediaTool('ffmpeg'),
      (error) => {
        assert.match(error.message, /^no ffmpeg on this host: looked at /);
        assert.ok(
          error.message.includes('/nonexistent/ffmpeg-that-was-never-installed'),
          `the refusal must quote the pin it was given: ${error.message}`,
        );
        assert.ok(
          error.message.includes('WELES_FFMPEG_BIN'),
          `the refusal must name the variable that fixes it: ${error.message}`,
        );
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.WELES_FFMPEG_BIN;
    else process.env.WELES_FFMPEG_BIN = previous;
  }
});
