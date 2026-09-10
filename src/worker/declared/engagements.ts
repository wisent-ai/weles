// Declared engagement: the capability that replaced one action verb per site.
//
// An engagement is one reviewed trajectory replayed against a target the
// submission names. Until this declaration existed, every (platform, verb)
// pair was also a public action name in
// src/worker/deploy/weles-action-allowlist.txt and a branch in ./dispatch.ts:
// seven sites spelled the same twenty-two verbs, 154 of the 255 admitted
// actions, and 108 of those rows resolved to a trajectory file nobody had
// written. Admission said yes to all of them because the catalog was the gate,
// and the run failed after the caller had already been told the work was
// accepted.
//
// So the verb is no longer the unit of authorization. The declaration below
// names, per engagement, its platform, its verb and the reviewed trajectory,
// `generic_saved_task` consumes it, and the two failures that used to land at
// execution land at admission instead:
//
//   * an engagement nobody declared is refused when it is submitted, and
//   * a declaration naming a missing reviewed trajectory is refused when it is
//     loaded — the whole declaration, not the one run that reached the gap.
//
// A new site is a row in that file, not another verb here.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The declaration, relative to the checkout it belongs to. */
export const ENGAGEMENT_DECLARATION_PATH = 'src/worker/deploy/weles-engagement-declaration.json';
export const ENGAGEMENT_DECLARATION_SCHEMA = 'wisent.weles-engagement-declaration.v1';

/** Reviewed trajectories live here, and a declaration may name nothing else. */
const TRAJECTORY_ROOT = 'src/trajectories/';

/** `<platform>.<verb>` — a declaration name, deliberately not an action name. */
const ENGAGEMENT_NAME = /^[a-z][a-z0-9]*\.[a-z][a-z0-9_]*$/;

export type DeclaredEngagement = {
  readonly engagement: string;
  readonly platform: string;
  readonly verb: string;
  readonly trajectory: string;
};

/**
 * The checkout this build reads its declaration from: the one the launcher
 * named, or the one this module was compiled into — `dist/worker/declared/` and
 * `src/worker/declared/` are both three directories below the repository root, so the
 * queued path, the API and a test against an isolated root all resolve the
 * same file without any of them passing a path.
 */
export function welesRepositoryRoot(): string {
  const declared = (process.env.WELES_REPO ?? '').trim();
  return declared ? resolve(declared) : resolve(__dirname, '..', '..', '..');
}

function field(entry: Record<string, unknown>, name: string): string {
  const value = entry[name];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Read and check the whole declaration, or refuse it.
 *
 * Every refusal here is a refusal of the declaration, not of one engagement:
 * a build whose declaration names a trajectory that is not in it cannot be
 * trusted to admit any engagement, and the operator needs to hear that from
 * the unit that starts rather than from the first caller who guesses right.
 */
export function loadDeclaredEngagements(
  repositoryRoot: string = welesRepositoryRoot(),
): Map<string, DeclaredEngagement> {
  const path = join(repositoryRoot, ENGAGEMENT_DECLARATION_PATH);
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${ENGAGEMENT_DECLARATION_PATH} could not be read: ${reason}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error(`${ENGAGEMENT_DECLARATION_PATH} must be one JSON object`);
  }
  const declaration = document as Record<string, unknown>;
  if (declaration.schema !== ENGAGEMENT_DECLARATION_SCHEMA) {
    throw new Error(`${ENGAGEMENT_DECLARATION_PATH} must declare schema ${ENGAGEMENT_DECLARATION_SCHEMA}`);
  }
  const entries = declaration.engagements;
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error(`${ENGAGEMENT_DECLARATION_PATH} must declare at least one engagement`);
  }
  const declared = new Map<string, DeclaredEngagement>();
  for (const [index, raw] of entries.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${ENGAGEMENT_DECLARATION_PATH} entry ${index} is not an object`);
    }
    const entry = raw as Record<string, unknown>;
    const engagement = field(entry, 'engagement');
    const platform = field(entry, 'platform');
    const verb = field(entry, 'verb');
    const trajectory = field(entry, 'trajectory');
    if (!engagement || !platform || !verb || !trajectory) {
      throw new Error(
        `${ENGAGEMENT_DECLARATION_PATH} entry ${index} must name engagement, platform, verb and trajectory`,
      );
    }
    if (!ENGAGEMENT_NAME.test(engagement)) {
      throw new Error(`${ENGAGEMENT_DECLARATION_PATH} declares the malformed engagement name ${engagement}`);
    }
    if (engagement !== `${platform}.${verb}`) {
      throw new Error(
        `${ENGAGEMENT_DECLARATION_PATH} declares engagement ${engagement} for platform ${platform} and verb ${verb}`,
      );
    }
    if (declared.has(engagement)) {
      throw new Error(`${ENGAGEMENT_DECLARATION_PATH} declares engagement ${engagement} twice`);
    }
    if (!trajectory.startsWith(TRAJECTORY_ROOT) || trajectory.includes('..')) {
      throw new Error(
        `declared engagement ${engagement} must name a reviewed trajectory under ${TRAJECTORY_ROOT}, not ${trajectory}`,
      );
    }
    if (!existsSync(join(repositoryRoot, trajectory))) {
      throw new Error(`declared engagement ${engagement} names a missing reviewed trajectory: ${trajectory}`);
    }
    declared.set(engagement, { engagement, platform, verb, trajectory });
  }
  return declared;
}

// One read per checkout per process. The declaration is release content, so it
// cannot change under a running unit, and admission stays a lookup: nothing on
// the submission path touches the filesystem.
const cached = new Map<string, Map<string, DeclaredEngagement>>();

export function declaredEngagements(
  repositoryRoot: string = welesRepositoryRoot(),
): Map<string, DeclaredEngagement> {
  const known = cached.get(repositoryRoot);
  if (known) return known;
  const loaded = loadDeclaredEngagements(repositoryRoot);
  cached.set(repositoryRoot, loaded);
  return loaded;
}

/**
 * Admission: the declared engagement a submission names, or the refusal a
 * caller gets instead of a run.
 */
export function admitEngagement(
  named: unknown,
  repositoryRoot: string = welesRepositoryRoot(),
): DeclaredEngagement {
  if (typeof named !== 'string' || !named.trim()) {
    throw new Error('engagement must name a declared engagement as <platform>.<verb>');
  }
  const engagement = named.trim();
  const declared = declaredEngagements(repositoryRoot).get(engagement);
  if (!declared) {
    throw new Error(`engagement ${engagement} is not declared in ${ENGAGEMENT_DECLARATION_PATH}`);
  }
  return declared;
}

/**
 * What `generic_saved_task` admits, translated into the env its child reads.
 *
 * This is the whole admission step for the capability, and it runs where the
 * per-verb branches used to: in the dispatcher, before anything is spawned.
 * A run replays either one declared engagement or one reviewed trajectory
 * named by id, never both — two declarations for one run are two answers to
 * "what does this replay".
 */
export function applySavedTaskEnv(
  params: Record<string, unknown>,
  trajPath: string,
  env: Record<string, string>,
): void {
  if (!trajPath.endsWith('/generic/saved_task.mjs')) return;
  const engagement = params.engagement;
  const trajectoryId = params.trajectory_id;
  if (engagement !== undefined && trajectoryId !== undefined) {
    throw new Error('generic_saved_task takes an engagement or a trajectory_id, not both');
  }
  if (engagement !== undefined) {
    const declared = admitEngagement(engagement);
    env.GENERIC_ENGAGEMENT = declared.engagement;
    env.GENERIC_ENGAGEMENT_TRAJECTORY = declared.trajectory;
    env.PLATFORM = declared.platform;
    env.VERB = declared.verb;
  }
  if (typeof trajectoryId === 'string') env.GENERIC_SAVED_TRAJECTORY_ID = trajectoryId;
}
