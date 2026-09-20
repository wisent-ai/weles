/**
 * Where this host's `ffmpeg` and `ffprobe` actually are.
 *
 * The recording path used to call `ffmpeg` as a bare word through a shell and
 * throw the failure away. Under launchd the worker's PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin` — the unit even names node by absolute path
 * for the same reason — so a Homebrew ffmpeg in `/opt/homebrew/bin` is simply
 * not on it. Every recording then ended as
 * `record_seconds N produced no video: the screencast captured no frames or
 * ffmpeg could not stitch them`, a sentence that cannot tell a browser that
 * sent no frames from a stitcher that was never found, and on 2026-09-20 that
 * was the whole diagnosis available for a capture which had otherwise executed
 * every one of its steps against app.wisent.com.
 *
 * So the tool is resolved, not assumed. The search is over places one binary
 * may be installed, never over alternative implementations: the first path
 * that exists is the tool this host runs, and whatever it then does — refuse
 * `-version`, fail a stitch — is reported as itself.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The media tools the recording path runs. Playwright bundles only ffmpeg. */
export type MediaTool = 'ffmpeg' | 'ffprobe';

/** Directories a Unix install puts these binaries in, most specific first. */
const TOOL_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] as const;

/** The `browsers.json` beside the resolved `playwright-core`. */
export function findPlaywrightManifest(): string {
  let directory = dirname(require.resolve('playwright-core'));
  for (let depth = 0; depth < Number('6'); depth += 1) {
    const candidate = join(directory, 'browsers.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('no browsers.json beside the resolved playwright-core');
}

/** Where Playwright keeps its downloads on this platform. */
export function playwrightCacheRoot(): string {
  const override = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (override) return override;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(home, 'AppData', 'Local', 'ms-playwright');
  return join(home, '.cache', 'ms-playwright');
}

/**
 * Playwright's own bundled ffmpeg for this release, by path.
 *
 * The revision is read from the Playwright this worker will actually load,
 * so the path moves when the dependency does. A release whose Playwright
 * declares no ffmpeg has none of these, which is a real answer rather than
 * an error: the host installation is then the one that counts.
 */
export function bundledFfmpegPath(): string | null {
  const parsed = JSON.parse(readFileSync(findPlaywrightManifest(), 'utf8')) as {
    browsers?: Array<{ name?: string; revision?: string }>;
  };
  const revision = (parsed.browsers ?? []).find((entry) => entry.name === 'ffmpeg')?.revision ?? '';
  if (!revision) return null;
  const name = process.platform === 'darwin'
    ? 'ffmpeg-mac'
    : process.platform === 'win32' ? 'ffmpeg-win64.exe' : 'ffmpeg-linux';
  return join(playwrightCacheRoot(), `ffmpeg-${revision}`, name);
}

/**
 * Every path this host may hold one tool at, in the order they are consulted.
 *
 * Playwright's bundled ffmpeg is first after an explicit pin, because a
 * managed worker installs it with its browser runtime and may carry no
 * other: charless-mac-mini has none of the usual install directories
 * populated, so leaving it out made every recording refuse with
 * `no ffmpeg on this host`.
 *
 * Exported so a refusal, a diagnostic and a test all quote the same list.
 */
export function mediaToolCandidates(tool: MediaTool): string[] {
  const candidates: string[] = [];
  const override = process.env[`WELES_${tool.toUpperCase()}_BIN`]?.trim();
  if (override) candidates.push(override);
  if (tool === 'ffmpeg') {
    const bundled = bundledFfmpegPath();
    if (bundled) candidates.push(bundled);
  }
  for (const directory of TOOL_DIRECTORIES) candidates.push(join(directory, tool));
  return candidates;
}

/**
 * The encoder the screencast stitch writes its WebM with. A build without
 * it answers `-version` perfectly and then cannot produce the one file the
 * recording exists for.
 */
const REQUIRED_FFMPEG_ENCODER = 'libvpx';

/**
 * The demuxer that reads the captured PNG sequence back in.
 *
 * Playwright's bundled build has the libvpx encoder and no image sequence
 * demuxer: it exists to encode frames Playwright pipes it, not to read a
 * directory. Handed one it answers `Error opening input: No such file or
 * directory` about a directory that is demonstrably full of frames, which
 * on 2026-09-20 read as a missing recording four separate times.
 */
const REQUIRED_FFMPEG_DEMUXER = 'image2';

/**
 * The executable this host will run for one tool, proven able to do the job.
 *
 * An explicit `WELES_<TOOL>_BIN` is the answer, not a suggestion: when it
 * names a path that is not there, the refusal says so rather than quietly
 * running some other copy, because an operator who pinned a build wants that
 * build in the evidence. Otherwise the first installed candidate is what
 * this host has; there is no second one, so a binary that is present and
 * unfit is reported as unfit rather than passed over.
 *
 * For ffmpeg the proof is both halves of the job — read a frame sequence,
 * write VP8 — because a build that can do one and not the other fails at
 * the last step, after the frames are already captured and the browser is
 * already gone.
 */
export function resolveMediaTool(tool: MediaTool): string {
  const variable = `WELES_${tool.toUpperCase()}_BIN`;
  const candidates = mediaToolCandidates(tool);
  const pinned = process.env[variable]?.trim();
  const installed = pinned || candidates.find((candidate) => existsSync(candidate));
  if (!installed || !existsSync(installed)) {
    throw new Error(
      `no ${tool} on this host: looked at ${candidates.join(', ')}. `
      + `Install it, or name it in ${variable}.`,
    );
  }
  if (tool === 'ffprobe') {
    ffmpegAnswer(installed, tool, variable, ['-version']);
    return installed;
  }
  const encoders = ffmpegAnswer(installed, tool, variable, ['-hide_banner', '-encoders']);
  if (!encoders.includes(REQUIRED_FFMPEG_ENCODER)) {
    throw new Error(
      `${installed} is an ffmpeg without the ${REQUIRED_FFMPEG_ENCODER} encoder, so it `
      + `cannot write the WebM a recording is stitched into. Install a full ffmpeg, or `
      + `name one in ${variable}.`,
    );
  }
  const demuxers = ffmpegAnswer(installed, tool, variable, ['-hide_banner', '-demuxers']);
  if (!demuxers.includes(REQUIRED_FFMPEG_DEMUXER)) {
    throw new Error(
      `${installed} is an ffmpeg without the ${REQUIRED_FFMPEG_DEMUXER} demuxer, so it `
      + `cannot read the captured frame sequence back and answers "No such file or `
      + `directory" about a directory that holds every frame. Install a full ffmpeg, `
      + `or name one in ${variable}.`,
    );
  }
  return installed;
}

/** One probe of a resolved tool, with its own refusal when it will not run. */
function ffmpegAnswer(
  binary: string,
  tool: MediaTool,
  variable: string,
  probe: string[],
): string {
  try {
    return execFileSync(binary, probe, { encoding: 'utf8', timeout: Number('10000') });
  } catch (error) {
    throw new Error(
      `${binary} is the ${tool} this host holds (${variable} pins another) and it did `
      + `not answer ${probe.join(' ')}: `
      + `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
