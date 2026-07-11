import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HOSTNAME, normalizeHostname } from './identity.js';

const REGISTRY_URI = process.env.STADO_REGISTRY_URI ?? 'gs://wisent-compute/registry.json';
const CACHE_TTL_MS = 30_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REGISTRY_BYTES = 1024 * 1024;
const ACTION_RE = /^[a-z0-9_]+$/;
const execFileAsync = promisify(execFile);

export interface WelesActionPolicy {
  enabled: boolean;
  actions: readonly string[];
  wildcard: boolean;
}

interface RegistryTarget {
  name: string;
  kind: string;
  hostnames: string[];
  sshHostname?: string;
  weles?: WelesActionPolicy;
}

export interface StadoRegistryV2 {
  schema_version: 2;
  targets: RegistryTarget[];
}

function objectRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, location: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${location} must be a non-empty string`);
  return value;
}

function parseSshHostname(value: unknown, location: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const ssh = requiredString(value, location).trim();
  const hostAndPort = ssh.slice(ssh.lastIndexOf('@') + 1);
  const host = hostAndPort.startsWith('[')
    ? hostAndPort.slice(1, hostAndPort.indexOf(']'))
    : hostAndPort.split(':', 1)[0];
  const normalized = normalizeHostname(host);
  if (!normalized) throw new Error(`${location} has no hostname`);
  return normalized;
}

function parseWelesPolicy(value: unknown, location: string): WelesActionPolicy {
  const raw = objectRecord(value, location);
  const unknownKeys = Object.keys(raw).filter((key) => key !== 'enabled' && key !== 'actions');
  if (unknownKeys.length) throw new Error(`${location} has unsupported fields`);
  if (typeof raw.enabled !== 'boolean') throw new Error(`${location}.enabled must be boolean`);
  if (!Array.isArray(raw.actions)) throw new Error(`${location}.actions must be an array`);

  const actions: string[] = [];
  const seen = new Set<string>();
  for (const [index, action] of raw.actions.entries()) {
    if (typeof action !== 'string' || !action || action.trim() !== action
      || (action !== '*' && !ACTION_RE.test(action))) {
      throw new Error(`${location}.actions[${index}] must be '*' or an exact lowercase action identifier`);
    }
    if (seen.has(action)) throw new Error(`${location}.actions contains duplicates`);
    seen.add(action);
    actions.push(action);
  }
  if (actions.includes('*') && actions.length !== 1) throw new Error(`${location}.actions wildcard must appear alone`);
  return { enabled: raw.enabled && actions.length > 0, actions, wildcard: actions[0] === '*' };
}

export function parseStadoRegistry(value: unknown): StadoRegistryV2 {
  const root = objectRecord(value, 'registry');
  if (root.schema_version !== 2) throw new Error('registry.schema_version must be 2');
  if (!Array.isArray(root.targets)) throw new Error('registry.targets must be an array');

  const names = new Set<string>();
  const identities = new Map<string, string>();
  const targets = root.targets.map((value, index): RegistryTarget => {
    const location = `registry.targets[${index}]`;
    const raw = objectRecord(value, location);
    const name = requiredString(raw.name, `${location}.name`);
    const normalizedName = normalizeHostname(name);
    if (!normalizedName) throw new Error(`${location}.name has no hostname`);
    if (names.has(normalizedName)) throw new Error('registry target names must be unique');
    names.add(normalizedName);
    const kind = requiredString(raw.kind, `${location}.kind`);

    let hostnames: string[] = [];
    if (raw.hostnames !== undefined) {
      if (!Array.isArray(raw.hostnames)) throw new Error(`${location}.hostnames must be an array`);
      hostnames = raw.hostnames.map((hostname, hostnameIndex) => {
        const normalized = normalizeHostname(requiredString(hostname, `${location}.hostnames[${hostnameIndex}]`));
        if (!normalized) throw new Error(`${location}.hostnames[${hostnameIndex}] has no hostname`);
        return normalized;
      });
      if (new Set(hostnames).size !== hostnames.length) throw new Error(`${location}.hostnames contains duplicates`);
    }

    if (raw.weles !== undefined && kind !== 'local') throw new Error(`${location}.weles is only valid for kind=local`);
    const sshHostname = parseSshHostname(raw.ssh, `${location}.ssh`);
    for (const identity of [normalizedName, ...hostnames, ...(sshHostname ? [sshHostname] : [])]) {
      const previous = identities.get(identity);
      if (previous) throw new Error(`${location} host identity ${identity} is already declared by ${previous}`);
      identities.set(identity, location);
    }
    return {
      name: normalizedName,
      kind,
      hostnames,
      sshHostname,
      weles: raw.weles === undefined ? undefined : parseWelesPolicy(raw.weles, `${location}.weles`),
    };
  });
  return { schema_version: 2, targets };
}

export function resolveWelesPolicy(registry: StadoRegistryV2, hostname: string): WelesActionPolicy {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error('OS hostname is empty');
  const matches = registry.targets.filter((target) =>
    target.kind === 'local'
    && (target.name === host || target.hostnames.includes(host) || target.sshHostname === host));
  if (matches.length > 1) throw new Error(`hostname ${host} matches multiple registry targets`);
  return matches[0]?.weles ?? { enabled: false, actions: [], wildcard: false };
}

let successCache: { loadedAt: number; policy: WelesActionPolicy } | undefined;
let inFlight: Promise<WelesActionPolicy> | undefined;

async function fetchAndResolvePolicy(): Promise<WelesActionPolicy> {
  let stdout: string;
  try {
    const result = await execFileAsync('gcloud', ['storage', 'cat', REGISTRY_URI], {
      encoding: 'utf8',
      timeout: FETCH_TIMEOUT_MS,
      maxBuffer: MAX_REGISTRY_BYTES,
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
    if (failure.killed || failure.code === 'ETIMEDOUT') throw new Error('Stado registry fetch timed out');
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Stado registry exceeds 1 MiB');
    throw new Error('Stado registry fetch failed');
  }
  if (Buffer.byteLength(stdout, 'utf8') > MAX_REGISTRY_BYTES) throw new Error('Stado registry exceeds 1 MiB');

  let decoded: unknown;
  try { decoded = JSON.parse(stdout); }
  catch { throw new Error('Stado registry is not valid JSON'); }
  const policy = resolveWelesPolicy(parseStadoRegistry(decoded), HOSTNAME);
  successCache = { loadedAt: Date.now(), policy };
  return policy;
}

export async function loadWelesPolicy(): Promise<WelesActionPolicy> {
  const mode = process.env.WELES_STADO_ROUTING ?? 'required';
  if (mode === 'off') return { enabled: true, actions: ['*'], wildcard: true };
  if (mode !== 'required') throw new Error('WELES_STADO_ROUTING must be required or off');
  if (successCache && Date.now() - successCache.loadedAt < CACHE_TTL_MS) return successCache.policy;
  if (!inFlight) {
    inFlight = fetchAndResolvePolicy();
    void inFlight.finally(() => { inFlight = undefined; }).catch(() => {});
  }
  return inFlight;
}
