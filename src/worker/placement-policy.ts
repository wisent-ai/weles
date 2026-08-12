import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOSTNAME, normalizeHostname } from './identity.js';

const POLICY_FILE = process.env.WELES_PLACEMENT_POLICY_FILE
  ?? join(homedir(), '.config', 'weles', 'placement-policy.json');
const CACHE_TTL_MS = 30_000;
const MAX_POLICY_BYTES = 1024 * 1024;
const ACTION_RE = /^[a-z0-9_]+$/;
const PUBLISH_COMMAND = 'stado host publish-placement-policy <host>';

export interface WelesActionPolicy {
  enabled: boolean;
  actions: readonly string[];
  wildcard: boolean;
}

interface HostPolicy extends WelesActionPolicy {
  hostname: string;
  aliases: string[];
}

// What the publisher stamped into the file it produced. `registry_generation`
// is the store's CAS version and is a string on some backends (a content hash,
// an opaque object version) and a decimal counter on others, so it is carried
// verbatim rather than coerced into a number that would either lie or throw.
export interface WelesPolicySource {
  registry_generation: string | number;
  published_at: string;
  by: string;
}

export interface WelesPlacementPolicyDocument {
  source: WelesPolicySource;
  schema_version: 1;
  hosts: HostPolicy[];
}

function objectRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, location: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function parseActions(value: unknown, location: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${location} must be an array`);
  const actions: string[] = [];
  const seen = new Set<string>();
  for (const [index, action] of value.entries()) {
    if (typeof action !== 'string' || !action || action.trim() !== action
      || (action !== '*' && !ACTION_RE.test(action))) {
      throw new Error(`${location}[${index}] must be '*' or an exact lowercase action identifier`);
    }
    if (seen.has(action)) throw new Error(`${location} contains duplicates`);
    seen.add(action);
    actions.push(action);
  }
  if (actions.includes('*') && actions.length !== 1) {
    throw new Error(`${location} wildcard must appear alone`);
  }
  return actions;
}

// Why an unstamped policy is refused instead of trusted.
//
// The Stado registry declares `weles.actions` per target, and the worker has
// never read it. This file is the real gate: the list claimOne intersects with
// the launcher allowlist is the one in here, and nothing in the worker ever
// consults the registry to find out whether the two agree. On 2026-08-11 they
// did not — the registry authorized an action for a host whose policy file,
// written by hand and never republished, did not list it — and the worker
// skipped an authorized row silently for hours. A file that answers every
// question is indistinguishable from a file that answers correctly.
//
// The `_source` stamp is what makes this file a cache of the registry rather
// than a rival to it: it names the registry generation the document was derived
// from, when it was published, and by which command. A document with no stamp
// has no derivation at all, so there is nothing it can be a cache of. It is
// refused, and the host claims nothing until `stado host publish-placement-policy`
// produces a stamped replacement — refusal being the safe reading of "we do not
// know what this host is allowed to run", not an error to be retried.
//
// Returns the sentence explaining the refusal, or null when the stamp is sound.
// Shape problems other than the stamp are left to the parser to throw about.
export function placementPolicyStampRefusal(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const stamp = (value as Record<string, unknown>)._source;
  const remedy = `\`${PUBLISH_COMMAND}\` produces a valid one`;
  if (stamp === undefined) {
    return `it carries no _source stamp, so it was hand-written or predates policy publication and is not derived from the registry; ${remedy}`;
  }
  if (!stamp || typeof stamp !== 'object' || Array.isArray(stamp)) {
    return `its _source stamp is not an object, so the derivation it claims cannot be read; ${remedy}`;
  }
  const { registry_generation: generation, published_at: publishedAt, by } = stamp as Record<string, unknown>;
  // The store's CAS version is a string on backends that version by content
  // hash or opaque header and a counter on backends that version by number.
  const generationStamped = typeof generation === 'string'
    ? generation.trim().length > 0
    : Number.isSafeInteger(generation) && (generation as number) >= 0;
  if (!generationStamped) {
    return `its _source.registry_generation is missing or empty, so it does not name the registry state it was published from; ${remedy}`;
  }
  if (typeof publishedAt !== 'string' || !publishedAt.trim()) {
    return `its _source.published_at is missing, so there is no telling how stale the derivation is; ${remedy}`;
  }
  if (typeof by !== 'string' || !by.trim()) {
    return `its _source.by is missing, so nothing records which command produced it; ${remedy}`;
  }
  return null;
}

export function parseWelesPlacementPolicy(value: unknown): WelesPlacementPolicyDocument {
  const root = objectRecord(value, 'placement policy');
  const refusal = placementPolicyStampRefusal(root);
  if (refusal) throw new Error(`placement policy is unpublished — ${refusal}`);
  const stamp = objectRecord(root._source, 'placement policy _source');
  const source: WelesPolicySource = {
    registry_generation: stamp.registry_generation as string | number,
    published_at: stamp.published_at as string,
    by: stamp.by as string,
  };
  if (root.schema_version !== 1) throw new Error('placement policy schema_version must be 1');
  if (!Array.isArray(root.hosts)) throw new Error('placement policy hosts must be an array');

  const identities = new Map<string, string>();
  const hosts = root.hosts.map((entry, index): HostPolicy => {
    const location = `placement policy hosts[${index}]`;
    const raw = objectRecord(entry, location);
    const unknownKeys = Object.keys(raw).filter((key) =>
      !['hostname', 'aliases', 'enabled', 'actions'].includes(key));
    if (unknownKeys.length) throw new Error(`${location} has unsupported fields`);

    const hostname = normalizeHostname(requiredString(raw.hostname, `${location}.hostname`));
    if (!hostname) throw new Error(`${location}.hostname has no hostname`);
    const aliases = raw.aliases === undefined ? [] : (() => {
      if (!Array.isArray(raw.aliases)) throw new Error(`${location}.aliases must be an array`);
      return raw.aliases.map((alias, aliasIndex) => {
        const normalized = normalizeHostname(requiredString(alias, `${location}.aliases[${aliasIndex}]`));
        if (!normalized) throw new Error(`${location}.aliases[${aliasIndex}] has no hostname`);
        return normalized;
      });
    })();
    if (typeof raw.enabled !== 'boolean') throw new Error(`${location}.enabled must be boolean`);
    const actions = parseActions(raw.actions, `${location}.actions`);

    for (const identity of [hostname, ...aliases]) {
      const previous = identities.get(identity);
      if (previous) throw new Error(`${location} host identity ${identity} is already declared by ${previous}`);
      identities.set(identity, location);
    }
    return {
      hostname,
      aliases,
      enabled: raw.enabled && actions.length > 0,
      actions,
      wildcard: actions[0] === '*',
    };
  });
  return { source, schema_version: 1, hosts };
}

export function resolveWelesPolicy(
  document: WelesPlacementPolicyDocument,
  hostname: string,
): WelesActionPolicy {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error('OS hostname is empty');
  const matches = document.hosts.filter((entry) =>
    entry.hostname === host || entry.aliases.includes(host));
  if (matches.length > 1) throw new Error(`hostname ${host} matches multiple placement entries`);
  const match = matches[0];
  return match
    ? { enabled: match.enabled, actions: match.actions, wildcard: match.wildcard }
    : { enabled: false, actions: [], wildcard: false };
}

let successCache: { loadedAt: number; policy: WelesActionPolicy } | undefined;
let inFlight: Promise<WelesActionPolicy> | undefined;

// A refusal is a standing condition, not an event: the loader re-reads the file
// every CACHE_TTL_MS and the poll loop never stops, so the sentence is printed
// when it appears and again only if it changes or a published policy takes
// over in between. Same reasoning as the denial cooldown in claim.ts.
let reportedRefusal: string | undefined;

function reportPolicyRefusal(refusal: string): void {
  if (reportedRefusal === refusal) return;
  reportedRefusal = refusal;
  console.error(`[worker] REFUSING the placement policy at ${POLICY_FILE} — ${refusal}. This host claims nothing until a published policy replaces it.`);
}

async function readAndResolvePolicy(): Promise<WelesActionPolicy> {
  let text: string;
  try {
    text = await readFile(POLICY_FILE, 'utf8');
  } catch {
    throw new Error(`Weles placement policy is unavailable: ${POLICY_FILE}`);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_POLICY_BYTES) {
    throw new Error('Weles placement policy exceeds 1 MiB');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error('Weles placement policy is not valid JSON');
  }
  // An unstamped document is refused rather than thrown about: 'error' would
  // make the worker look broken and invite a retry, when the truthful state is
  // that this host is authorized for nothing. Refused and empty are the same
  // policy — enabled:false, no actions — so pollOnce reports it through the
  // usual denial path and the host idles visibly instead of claiming blind.
  const refusal = placementPolicyStampRefusal(decoded);
  if (refusal) {
    reportPolicyRefusal(refusal);
    const refused: WelesActionPolicy = { enabled: false, actions: [], wildcard: false };
    successCache = { loadedAt: Date.now(), policy: refused };
    return refused;
  }
  const policy = resolveWelesPolicy(parseWelesPlacementPolicy(decoded), HOSTNAME);
  reportedRefusal = undefined;
  successCache = { loadedAt: Date.now(), policy };
  return policy;
}

export async function loadWelesPolicy(): Promise<WelesActionPolicy> {
  const mode = process.env.WELES_PLACEMENT_MODE ?? 'required';
  if (mode === 'off') return { enabled: true, actions: ['*'], wildcard: true };
  if (mode !== 'required') throw new Error('WELES_PLACEMENT_MODE must be required or off');
  if (successCache && Date.now() - successCache.loadedAt < CACHE_TTL_MS) return successCache.policy;
  if (!inFlight) {
    inFlight = readAndResolvePolicy();
    void inFlight.finally(() => { inFlight = undefined; }).catch(() => {});
  }
  return inFlight;
}
