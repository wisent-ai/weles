import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HOSTNAME, normalizeHostname } from './identity.js';

const POLICY_FILE = process.env.WELES_PLACEMENT_POLICY_FILE
  ?? join(homedir(), '.config', 'weles', 'placement-policy.json');
const CACHE_TTL_MS = 30_000;
const MAX_POLICY_BYTES = 1024 * 1024;
const ACTION_RE = /^[a-z0-9_]+$/;

export interface WelesActionPolicy {
  enabled: boolean;
  actions: readonly string[];
  wildcard: boolean;
}

interface HostPolicy extends WelesActionPolicy {
  hostname: string;
  aliases: string[];
}

export interface WelesPlacementPolicyDocument {
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

export function parseWelesPlacementPolicy(value: unknown): WelesPlacementPolicyDocument {
  const root = objectRecord(value, 'placement policy');
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
  return { schema_version: 1, hosts };
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
  const policy = resolveWelesPolicy(parseWelesPlacementPolicy(decoded), HOSTNAME);
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
