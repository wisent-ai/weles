// `weles recordings scrub`: rewrite every stored run's provenance envelope so
// no environment value stays on disk. Runs recorded before Weles stopped
// keeping values held the process environment in session_meta.json
// `env_all`; this replaces each such object with `env_names`, the sorted
// names alone, exactly as a new run records them, and reports every file it
// changed, or that it could not read or write. The recordings root is
// WELES_RECORDINGS_ROOT, the one new runs write to. The rewritten file keeps
// the permissions it had.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ParsedCli } from '../../cli.js';
import { recordingsBase } from '../../session/run-recordings.js';
import { environmentNames } from '../../utils/sanitize-env.js';
import { printAnswer, UsageError } from '../usage.js';

const ENVELOPE = 'session_meta.json';

/** A scrub that left envelopes unread or unwritten, each named with why. */
class ScrubIncomplete extends Error {}

/** Every session_meta.json below `root`, at any depth. */
async function envelopes(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === ENVELOPE)
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Whether `file` held environment values and was rewritten to their names. */
async function scrubEnvelope(file: string): Promise<boolean> {
  const envelope = JSON.parse(await readFile(file, 'utf8')) as Record<
    string,
    unknown
  >;
  const recorded = envelope.env_all;
  if (recorded === undefined) return false;
  if (
    recorded === null ||
    typeof recorded !== 'object' ||
    Array.isArray(recorded)
  ) {
    throw new Error(
      `env_all is ${JSON.stringify(recorded)}, not an environment object`,
    );
  }
  delete envelope.env_all;
  envelope.env_names = environmentNames(
    recorded as Record<string, string | undefined>,
  );
  await writeFile(file, `${JSON.stringify(envelope, null, '\t')}\n`);
  return true;
}

export async function runRecordingsScrub(parsed: ParsedCli): Promise<void> {
  const [verb, ...rest] = parsed.positional;
  if (verb !== 'scrub')
    throw new UsageError(`weles recordings takes scrub, not ${verb}`);
  if (rest.length)
    throw new UsageError('recordings scrub takes no positional argument');
  const root = recordingsBase();
  const scrubbed: string[] = [];
  const clean: string[] = [];
  const failed: { file: string; error: string }[] = [];
  for (const file of await envelopes(root)) {
    try {
      ((await scrubEnvelope(file)) ? scrubbed : clean).push(file);
    } catch (error) {
      failed.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  printAnswer(
    { root, scrubbed, clean: clean.length, failed },
    parsed.options.json === true,
  );
  if (failed.length) {
    throw new ScrubIncomplete(
      `${failed.length} recording envelope(s) under ${root} could not be scrubbed; each is listed with why`,
    );
  }
}
