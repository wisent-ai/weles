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

/**
 * Where Playwright keeps its downloads on this platform.
 *
 * Exported because the runtime report and the recording path must agree on
 * this directory; two copies of the rule is how a component gets reported
 * present while not being the file anyone runs.
 */
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
 * The revision is read from the Playwright this worker will actually load, so
 * the path moves when the dependency does. A release whose Playwright
 * declares no ffmpeg has none of these, which is a real answer and not an
 * error: the host installation is then the one that counts.
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
 * The executable this host will run for one tool, proven to answer.
 *
 * An explicit `WELES_<TOOL>_BIN` is the answer, not a suggestion: when it
 * names a path that is not there, the refusal says so rather than quietly
 * running some other copy, because an operator who pinned a build wants that
 * build in the evidence. Otherwise the first installed candidate is what
 * this host has; there is no second one, so a binary that is present and
 * broken is reported as broken rather than passed over. Answering
 * `-version` is checked here because the alternative is finding out three
 * minutes into a run whose evidence is then lost.
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
  try {
    execFileSync(installed, ['-version'], { stdio: 'ignore', timeout: Number('10000') });
  } catch (error) {
    throw new Error(
      `${installed} is the ${tool} this host holds and it did not answer -version: `
      + `${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return installed;
}
