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
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The media tools the recording path runs. Playwright bundles only ffmpeg. */
export type MediaTool = 'ffmpeg' | 'ffprobe';

/** Directories a Unix install puts these binaries in, most specific first. */
const TOOL_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] as const;


/**
 * Every path this host may hold one tool at, in the order they are consulted.
 *
 * Playwright's bundled `ffmpeg` is deliberately NOT here. It is a build cut
 * down to what Playwright's own recorder needs, and its configuration says
 * so: `--enable-encoder=png --enable-zlib --enable-muxer=image2`, no libvpx
 * and no webm muxer. Resolving to it looked right and failed at the last
 * step — on 2026-09-20 a capture of app.wisent.com collected 5,355 frames
 * and then could not write a single WebM, which is the most expensive place
 * to learn that a tool cannot do the job.
 *
 * Exported so a refusal, a diagnostic and a test all quote the same list.
 */
export function mediaToolCandidates(tool: MediaTool): string[] {
  const candidates: string[] = [];
  const override = process.env[`WELES_${tool.toUpperCase()}_BIN`]?.trim();
  if (override) candidates.push(override);
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
 * The executable this host will run for one tool, proven able to do the job.
 *
 * An explicit `WELES_<TOOL>_BIN` is the answer, not a suggestion: when it
 * names a path that is not there, the refusal says so rather than quietly
 * running some other copy, because an operator who pinned a build wants that
 * build in the evidence. Otherwise the first installed candidate is what
 * this host has; there is no second one, so a binary that is present and
 * unfit is reported as unfit rather than passed over.
 *
 * For ffmpeg the proof is the encoder list, not `-version`. Playwright's
 * bundled build answers `-version` and carries `--enable-encoder=png` and
 * nothing else useful; resolving to it cost a 5,355-frame recording of
 * app.wisent.com on 2026-09-20, discovered at the last step.
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
  const probe = tool === 'ffmpeg' ? ['-hide_banner', '-encoders'] : ['-version'];
  let answer = '';
  try {
    answer = execFileSync(installed, probe, {
      encoding: 'utf8',
      timeout: Number('10000'),
    });
  } catch (error) {
    throw new Error(
      `${installed} is the ${tool} this host holds and it did not answer `
      + `${probe.join(' ')}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (tool === 'ffmpeg' && !answer.includes(REQUIRED_FFMPEG_ENCODER)) {
    throw new Error(
      `${installed} is an ffmpeg without the ${REQUIRED_FFMPEG_ENCODER} encoder, so it `
      + `cannot write the WebM a recording is stitched into. Install a full ffmpeg, or `
      + `name one in ${variable}.`,
    );
  }
  return installed;
}
