// Declared observation: the capability that replaced one benign-activity verb
// per site.
//
// An observation is one reviewed trajectory reading one declared origin under
// a declared dwell budget. Until this declaration existed, every
// (platform, verb) pair was also a public action name in
// src/worker/deploy/weles-action-allowlist.txt and a branch in ./dispatch.ts:
// browse, dwell, notifications, profile_view and search on nine platforms,
// 37 of the 101 admitted actions, and 30 of those rows resolved to the same
// single file — src/trajectories/_shared/benign.mjs, thirty public names for
// one behaviour. What the origin was and how long the run should dwell lived
// in a table inside that file, where no caller and no operator could read it,
// and its `dwellMs` column was never even applied: the loop called
// humanIdlePause() with no argument, so every declared range was dead data.
//
// So the verb is no longer the unit of authorization, and the origin and the
// budget are no longer buried in a trajectory. The declaration below names,
// per observation, its platform, its verb, the origin it reads, what it must
// read there, the dwell budget it spends and the reviewed trajectory,
// `generic_keeper_task` consumes it, and the two failures that used to land
// at execution land at admission instead:
//
//   * an observation nobody declared is refused when it is submitted, and
//   * a declaration naming a missing reviewed trajectory is refused when it
//     is loaded — the whole declaration, not the one run that reached the gap.
//
// Four of the 37 rows are not in the declaration, because no origin could
// have made them observe what they named, and a capability must not carry a
// promise its predecessor never kept:
//
//   * discord_search and discord_profile_view both resolved to
//     https://discord.com/channels/@me — the direct-message client, which
//     shows neither search results nor a profile. Submit discord.dwell, which
//     is what those rows actually did.
//   * instagram_notifications opened the home feed with a scroll budget of
//     zero and a `notifications_bell` marker nothing ever read. Submit
//     instagram.dwell.
//   * youtube_dwell resolved to benign.mjs, which carried no youtube origin
//     and no youtube ban detector, so the row could only ever fail.
//
// A new site is a row in that file, not another verb here.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { welesRepositoryRoot } from './engagements.js';

/** The declaration, relative to the checkout it belongs to. */
export const OBSERVATION_DECLARATION_PATH = 'src/worker/deploy/weles-observation-declaration.json';
export const OBSERVATION_DECLARATION_SCHEMA = 'wisent.weles-observation-declaration.v1';

/** Reviewed trajectories live here, and a declaration may name nothing else. */
const TRAJECTORY_ROOT = 'src/trajectories/';

/** `<platform>.<verb>` — a declaration name, deliberately not an action name. */
const OBSERVATION_NAME = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/;

/**
 * What a run must read, and the origin placeholder that proves the declared
 * origin can show it. This is the reality check on the declaration: an origin
 * that carries no query cannot produce search results however the row is
 * labelled, and one that carries no handle cannot produce a profile.
 */
const READS: Record<string, string> = {
  feed: '',
  notifications: '',
  search_results: 'query',
  profile: 'handle',
};

/** Placeholders an origin may carry; a submission names each one by this key. */
const PLACEHOLDERS: Record<string, true> = { query: true, handle: true, subreddit: true };

const PLACEHOLDER = /\{([a-z_]+)\}/g;

/** Submission keys the declaration owns: naming one beside an observation is
 * a second answer to what the run reads and how long it stays. */
const OWNED_BY_DECLARATION = ['url', 'objective', 'target_url', 'target_user', 'search_query', 'posts_to_browse'];

export type ObservationDwell = { readonly scrolls: number; readonly ms: readonly [number, number] };

export type DeclaredObservation = {
  readonly observation: string;
  readonly platform: string;
  readonly verb: string;
  readonly origin: string;
  readonly reads: string;
  readonly dwell: ObservationDwell;
  readonly trajectory: string;
};

function field(entry: Record<string, unknown>, name: string): string {
  const value = entry[name];
  return typeof value === 'string' ? value.trim() : '';
}

function dwellOf(raw: unknown): ObservationDwell | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { scrolls, ms } = raw as Record<string, unknown>;
  if (typeof scrolls !== 'number' || !Number.isInteger(scrolls) || scrolls < 0) return null;
  if (!Array.isArray(ms) || ms.length !== 2) return null;
  const [low, high] = ms as unknown[];
  if (typeof low !== 'number' || typeof high !== 'number') return null;
  if (!Number.isInteger(low) || !Number.isInteger(high) || low <= 0 || high < low) return null;
  return { scrolls, ms: [low, high] };
}

/**
 * Read and check the whole declaration, or refuse it.
 *
 * Every refusal here is a refusal of the declaration, not of one observation:
 * a build whose declaration names a trajectory that is not in it cannot be
 * trusted to admit any observation, and the operator needs to hear that from
 * the unit that starts rather than from the first caller who guesses right.
 */
export function loadDeclaredObservations(
  repositoryRoot: string = welesRepositoryRoot(),
): Map<string, DeclaredObservation> {
  const path = join(repositoryRoot, OBSERVATION_DECLARATION_PATH);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${OBSERVATION_DECLARATION_PATH} could not be read: ${reason}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${OBSERVATION_DECLARATION_PATH} must be one JSON object`);
  }
  const declaration = document as Record<string, unknown>;
  if (declaration.schema !== OBSERVATION_DECLARATION_SCHEMA) {
    throw new Error(`${OBSERVATION_DECLARATION_PATH} must declare schema ${OBSERVATION_DECLARATION_SCHEMA}`);
  }
  const entries = declaration.observations;
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error(`${OBSERVATION_DECLARATION_PATH} must declare at least one observation`);
  }
  const declared = new Map<string, DeclaredObservation>();
  for (const [index, raw] of entries.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${OBSERVATION_DECLARATION_PATH} entry ${index} is not an object`);
    }
    const entry = raw as Record<string, unknown>;
    const observation = field(entry, 'observation');
    const platform = field(entry, 'platform');
    const verb = field(entry, 'verb');
    const origin = field(entry, 'origin');
    const reads = field(entry, 'reads');
    const trajectory = field(entry, 'trajectory');
    if (!observation || !platform || !verb || !origin || !reads || !trajectory) {
      throw new Error(
        `${OBSERVATION_DECLARATION_PATH} entry ${index} must name observation, platform, verb, origin, reads and trajectory`,
      );
    }
    if (!OBSERVATION_NAME.test(observation)) {
      throw new Error(`${OBSERVATION_DECLARATION_PATH} declares the malformed observation name ${observation}`);
    }
    if (observation !== `${platform}.${verb}`) {
      throw new Error(
        `${OBSERVATION_DECLARATION_PATH} declares observation ${observation} for platform ${platform} and verb ${verb}`,
      );
    }
    if (declared.has(observation)) {
      throw new Error(`${OBSERVATION_DECLARATION_PATH} declares observation ${observation} twice`);
    }
    if (!(reads in READS)) {
      throw new Error(
        `declared observation ${observation} must read one of ${Object.keys(READS).join(', ')}, not ${reads}`,
      );
    }
    if (!origin.startsWith('https://')) {
      throw new Error(`declared observation ${observation} must name an https origin, not ${origin}`);
    }
    const carried = [...origin.matchAll(PLACEHOLDER)].map((match) => match[1]);
    for (const name of carried) {
      if (!PLACEHOLDERS[name]) {
        throw new Error(`declared observation ${observation} names the unknown origin placeholder {${name}}`);
      }
    }
    const required = READS[reads];
    if (required && !carried.includes(required)) {
      throw new Error(`declared observation ${observation} reads ${reads}, so its origin must carry {${required}}`);
    }
    const dwell = dwellOf(entry.dwell);
    if (!dwell) {
      throw new Error(
        `declared observation ${observation} must declare a dwell budget of whole scrolls and an ascending ms range`,
      );
    }
    if (!trajectory.startsWith(TRAJECTORY_ROOT) || trajectory.includes('..')) {
      throw new Error(
        `declared observation ${observation} must name a reviewed trajectory under ${TRAJECTORY_ROOT}, not ${trajectory}`,
      );
    }
    if (!existsSync(join(repositoryRoot, trajectory))) {
      throw new Error(`declared observation ${observation} names a missing reviewed trajectory: ${trajectory}`);
    }
    declared.set(observation, { observation, platform, verb, origin, reads, dwell, trajectory });
  }
  return declared;
}

// One read per checkout per process. The declaration is release content, so it
// cannot change under a running unit, and admission stays a lookup: nothing on
// the submission path touches the filesystem.
const cached = new Map<string, Map<string, DeclaredObservation>>();

export function declaredObservations(
  repositoryRoot: string = welesRepositoryRoot(),
): Map<string, DeclaredObservation> {
  const known = cached.get(repositoryRoot);
  if (known) return known;
  const loaded = loadDeclaredObservations(repositoryRoot);
  cached.set(repositoryRoot, loaded);
  return loaded;
}

/**
 * Admission: the declared observation a submission names, or the refusal a
 * caller gets instead of a run.
 */
export function admitObservation(
  named: unknown,
  repositoryRoot: string = welesRepositoryRoot(),
): DeclaredObservation {
  if (typeof named !== 'string' || !named.trim()) {
    throw new Error('observation must name a declared observation as <platform>.<verb>');
  }
  const observation = named.trim();
  const declared = declaredObservations(repositoryRoot).get(observation);
  if (!declared) {
    throw new Error(`observation ${observation} is not declared in ${OBSERVATION_DECLARATION_PATH}`);
  }
  return declared;
}

/**
 * The origin the run navigates to: the declared one, with every placeholder it
 * carries filled from the submission. A placeholder the submission does not
 * name is refused here rather than navigated to as the literal `{handle}`.
 */
export function resolveObservationOrigin(
  declared: DeclaredObservation,
  params: Record<string, unknown>,
): string {
  return declared.origin.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name];
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`observation ${declared.observation} reads ${declared.reads} and needs ${name}`);
    }
    // A name a caller types carries the site's own prefix — @handle, r/sub,
    // u/name — and each per-site trajectory used to strip its own. One origin
    // template replaced all of them, so the stripping lives here, once, and
    // only for a name: a search query is whatever the caller meant, prefix
    // and all.
    const trimmed = value.trim();
    const bare = name === 'query'
      ? trimmed
      : trimmed.replace(/^@+/, '').replace(/^\/?[ru]\//, '').replace(/\/+$/, '');
    return encodeURIComponent(bare);
  });
}

/**
 * What `generic_keeper_task` admits, translated into the env its child reads.
 *
 * This is the whole admission step for the capability, and it runs where the
 * per-verb branches used to: in the dispatcher, before anything is spawned.
 * A run reads either one declared observation or the objective the keeper task
 * was given, never both — the declaration owns the origin and the budget, so a
 * submission that also names one is two answers to "what does this read".
 */
export function applyKeeperTaskEnv(
  params: Record<string, unknown>,
  trajPath: string,
  env: Record<string, string>,
): void {
  if (!trajPath.endsWith('/generic/keeper_task.mjs')) return;
  const named = params.observation;
  if (named === undefined) return;
  for (const key of OWNED_BY_DECLARATION) {
    if (params[key] !== undefined) {
      throw new Error(`generic_keeper_task takes a declared observation or ${key}, not both`);
    }
  }
  const declared = admitObservation(named);
  env.GENERIC_OBSERVATION = declared.observation;
  env.GENERIC_OBSERVATION_TRAJECTORY = declared.trajectory;
  env.GENERIC_OBSERVATION_ORIGIN = resolveObservationOrigin(declared, params);
  env.GENERIC_OBSERVATION_READS = declared.reads;
  env.GENERIC_OBSERVATION_SCROLLS = String(declared.dwell.scrolls);
  env.GENERIC_OBSERVATION_DWELL_MS = declared.dwell.ms.join(',');
  env.PLATFORM = declared.platform;
  env.VERB = declared.verb;
  delete env.GENERIC_TASK_URL;
  delete env.GENERIC_TASK_OBJECTIVE;
}
