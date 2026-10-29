// Shared run-diagnostics provenance import used by queued worker jobs and
// persistent keeper sessions.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  analyzeChallengeOutcome,
  type ChallengeOutcome,
} from './challenge_outcome.js';
import { environmentNames } from '../../utils/sanitize-env.js';
import { recordingsBase } from '../../session/run-recordings.js';

type JsonRead = { value: any | null; failure: string | null };

/** A run file that exists but could not be found, read or parsed, named with its cause. */
function readFailed(where: string, error: unknown): JsonRead {
  const cause = error instanceof Error ? error.message : String(error);
  return { value: null, failure: where ? `${where}: ${cause}` : cause };
}

/** A HAR that could not be analysed, named with its cause. */
function unanalysed(error: unknown): {
  outcome: ChallengeOutcome | null;
  failure: string;
} {
  const cause = error instanceof Error ? error.message : String(error);
  return {
    outcome: null,
    failure: `session.har could not be analysed: ${cause}`,
  };
}

// Artifacts live under recordings/<run_uuid>/ across varying sub-action/label
// dirs. Find a file by name anywhere in the run's tree.
async function findInRun(
  runId: string,
  filename: string,
): Promise<string | null> {
  async function walk(dir: string): Promise<string | null> {
    let entries: any[];
    try {
      entries = (await readdir(dir, { withFileTypes: true } as any)) as any;
    } catch (error) {
      // A directory that is not there holds nothing; one that cannot be
      // listed is thrown with its path, so a file in it is not taken as absent.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(
        `run directory ${dir} cannot be listed: ${(error as Error).message}`,
      );
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        const r = await walk(full);
        if (r) return r;
      } else if (e.name === filename) return full;
    }
    return null;
  }
  return walk(join(recordingsBase(), runId));
}
// The run's file and its parsed content: value null when the file is absent;
// failure names a file that exists but cannot be read or is not JSON, which
// is not the same as absent (an unreadable session_meta.json used to read as
// a run that died before any session existed).
async function readJsonInRun(
  runId: string,
  filename: string,
): Promise<JsonRead> {
  let p: string | null;
  try {
    p = await findInRun(runId, filename);
  } catch (error) {
    return readFailed('', error);
  }
  if (!p) return { value: null, failure: null };
  try {
    return { value: JSON.parse(await readFile(p, 'utf8')), failure: null };
  } catch (error) {
    return readFailed(p, error);
  }
}

export interface RunProvenance {
  session?: Record<string, unknown>;
  identity?: unknown;
  run?: { timing_seed: number };
  challenge_outcome?: ChallengeOutcome;
}

// Decode the captcha/challenge outcome (type, grid, objects, verdicts, whether
// LinkedIn accepted) from the run's HAR — the only artifact that carries the
// reCAPTCHA response bodies. No HAR, or no challenge in it, is no outcome; a
// HAR that cannot be read, has no entries or cannot be analysed is a failure
// named as such, not taken for a run that met no challenge.
export async function readChallengeOutcome(
  runId: string,
): Promise<{ outcome: ChallengeOutcome | null; failure: string | null }> {
  const har = await readJsonInRun(runId, 'session.har');
  if (har.failure) return { outcome: null, failure: har.failure };
  if (!har.value) return { outcome: null, failure: null };
  const entries = har.value.log?.entries;
  if (!Array.isArray(entries)) {
    return { outcome: null, failure: 'session.har has no log.entries array' };
  }
  try {
    const co = analyzeChallengeOutcome(entries);
    return { outcome: co.present ? co : null, failure: null };
  } catch (error) {
    return unanalysed(error);
  }
}

/**
 * The environment variable names a run recorded: its env_names, or the names
 * of an older envelope's env_all (whose values are never carried on), or
 * none when it recorded neither.
 */
function recordedEnvironmentNames(m: Record<string, unknown>): string[] {
  if (Array.isArray(m.env_names))
    return m.env_names.filter(
      (name): name is string => typeof name === 'string',
    );
  const recorded = m.env_all;
  if (recorded && typeof recorded === 'object' && !Array.isArray(recorded)) {
    return environmentNames(recorded as Record<string, string | undefined>);
  }
  return [];
}

// Build the rich result.session (+ identity + run) from session_meta.json /
// proxy_preflight.json written by WSession. A run that died before any
// session existed is answered as meta_missing (or meta_unreadable) with the
// proxy it requested — so a run is never a black hole. Mirrors the worker
// importer exactly.
export async function importRunProvenance(
  runId: string,
  params?: Record<string, unknown>,
): Promise<RunProvenance> {
  const out: RunProvenance = {};
  const meta = await readJsonInRun(runId, 'session_meta.json');
  const m = meta.value;
  if (m) {
    out.session = {
      proxy_host: m.proxy_host,
      proxy_port: m.proxy_port,
      proxy_user_present: !!m.proxy_user_present,
      proxy_user_hash: m.proxy_user_hash,
      exit_ip: m.exit_ip,
      platform: m.platform,
      provider: m.provider,
      browser_provenance: m.browser_provenance,
      persona: m.persona,
      realized_fingerprint: m.realized_fingerprint,
      proxy_requested: m.proxy_requested,
      env_flags: m.env_flags,
      env_names: recordedEnvironmentNames(m),
      sticky_session_id: m.sticky_session_id,
      sticky_hash: m.sticky_hash,
      exit_reputation: m.exit_reputation,
    };
    if (m.identity) out.identity = m.identity;
    if (typeof m.timing_seed === 'number')
      out.run = { timing_seed: m.timing_seed };
  } else {
    out.session = {
      // An unreadable meta file is named as such, not taken for a run that
      // died before any session existed.
      ...(meta.failure
        ? { meta_unreadable: meta.failure }
        : { meta_missing: true }),
      proxy_requested: (params as Record<string, unknown> | undefined)
        ?.proxy_url_override,
    };
  }
  const preflight = await readJsonInRun(runId, 'proxy_preflight.json');
  const pf = preflight.value;
  if (pf) {
    if (out.session)
      (out.session as Record<string, unknown>).proxy_preflight = pf;
    else out.session = { proxy_preflight: pf };
  } else if (preflight.failure && out.session) {
    (out.session as Record<string, unknown>).proxy_preflight_unreadable =
      preflight.failure;
  }
  const chrome = await readJsonInRun(runId, 'real_chrome_session.json');
  const rc = chrome.value;
  if (rc) {
    if (out.session) (out.session as Record<string, unknown>).real_chrome = rc;
    else out.session = { real_chrome: rc };
  } else if (chrome.failure && out.session) {
    (out.session as Record<string, unknown>).real_chrome_unreadable =
      chrome.failure;
  }
  const challenge = await readChallengeOutcome(runId);
  if (challenge.outcome) out.challenge_outcome = challenge.outcome;
  else if (challenge.failure && out.session)
    (out.session as Record<string, unknown>).challenge_outcome_unreadable =
      challenge.failure;
  return out;
}
