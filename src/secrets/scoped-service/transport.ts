import { spawnSync } from 'node:child_process';
import { constants as fsConstants, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolvedAcquiredSecretContract, SERVICE_CONTRACTS } from './contracts.js';
import type { InternalAcquiredSecretContract } from './contracts.js';
const TENANT_HEX_RE = /^[a-f\d-]+$/i;
const TENANT_PART_LENGTHS = Object.freeze([
  'xxxxxxxx'.length,
  'xxxx'.length,
  'xxxx'.length,
  'xxxx'.length,
  'xxxxxxxxxxxx'.length,
]);

function checkedTenantDirectory(tenantId: string): string {
  const parts = tenantId.split('-');
  if (!TENANT_HEX_RE.test(tenantId)
    || parts.length !== TENANT_PART_LENGTHS.length
    || parts.some((part, index) => part.length !== TENANT_PART_LENGTHS[index])) {
    throw new Error('invalid Weles tenant id for Skarbiec binding');
  }
  const root = process.env.WELES_SKARBIEC_TENANTS_DIR?.trim()
    || join(homedir(), '.stado', 'weles-skarbiec-tenants');
  if (!isAbsolute(root)) throw new Error('WELES_SKARBIEC_TENANTS_DIR must be absolute');
  const directory = join(root, tenantId);
  const metadata = lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & (fsConstants.S_IRWXG | fsConstants.S_IRWXO)) !== ''.length) {
    throw new Error(`refusing unsafe tenant Skarbiec binding directory for ${tenantId}`);
  }
  return directory;
}

function checkedTenantFile(path: string, label: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & (fsConstants.S_IRWXG | fsConstants.S_IRWXO)) !== ''.length) {
    throw new Error(`refusing unsafe tenant Skarbiec ${label}`);
  }
  return path;
}


export function hasWelesAcquiredSecretWriter(secret: string, tenantId?: string | null): boolean {
  const contract = resolvedAcquiredSecretContract(secret);
  if (!contract) return false;
  try {
    skarbiecEndpoint(tenantId);
    return Boolean(checkedTokenFile(contract.writerTokenFile, tenantId));
  } catch {
    return false;
  }
}

export type WelesServiceSecret = keyof typeof SERVICE_CONTRACTS;

export function skarbiecEndpoint(_tenantId?: string | null): string {
  const raw = process.env.WC_SKARBIEC_URL?.trim() ?? '';
  if (!raw) throw new Error('WC_SKARBIEC_URL is required from the Stado service directory');
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('WC_SKARBIEC_URL is invalid');
  }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === '::1' || endpoint.hostname === '[::1]';
  if (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) {
    throw new Error('WC_SKARBIEC_URL must use HTTPS or authenticated loopback HTTP');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new Error('WC_SKARBIEC_URL must be an origin without credentials, query, or fragment');
  }
  return endpoint.toString().replace(/\/$/, '');
}

export function checkedTokenFile(fileName: string, tenantId?: string | null): string | null {
  const path = tenantId
    ? join(checkedTenantDirectory(tenantId), fileName)
    : join(homedir(), '.stado', fileName);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch {
    return null;
  }
  const unsafeBits = Number.parseInt('77', Number('8'));
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & unsafeBits) !== Number('0')) {
    throw new Error(`refusing unsafe scoped Skarbiec token file for ${fileName}`);
  }
  return path;
}

export function readScopedField(
  consumer: string,
  item: string,
  tokenFileName: string,
  field: string,
): string | undefined {
  const tokenFile = checkedTokenFile(tokenFileName);
  if (!tokenFile) return undefined;
  const binary = process.env.WELES_STADO_BIN?.trim() || join(homedir(), '.stado', 'bin', 'stado');
  const result = spawnSync(binary, ['secrets', 'get', item, '--field', field], {
    encoding: 'buffer',
    maxBuffer: Number('65536'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: homedir(),
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      WC_SKARBIEC_URL: skarbiecEndpoint(),
      WC_SKARBIEC_CONSUMER: consumer,
      WC_SKARBIEC_TOKEN_FILE: tokenFile,
    },
  });
  const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(Number('0'));
  try {
    if (result.error || result.status !== Number('0')) {
      throw new Error(`scoped Skarbiec read failed for ${item}/${field}`);
    }
    const value = output.toString('utf8').replace(/[\r\n]+$/, '');
    if (!value || /[\r\n]/.test(value) || value.includes(String.fromCharCode(Number('0')))) {
      throw new Error(`scoped Skarbiec returned an invalid value for ${item}/${field}`);
    }
    return value;
  } finally {
    output.fill(Number('0'));
  }
}
// A deploy-side file of THIS revision. The scope table and the code that checks
// against it are one declaration split across two files, so they must come from one
// tree: the previous default resolved them under ~/weles, which is a symlink into
// whichever release is currently activated, while the trajectory itself ran from a
// different checkout. Updating the table in the checkout that runs therefore left the
// activated release's older table in force, and the read failed on the helper's own
// scope check with "undeclared Skarbiec acquisition scope" while the authority was
// never even asked (observed 2026-08-17 for claude-wisent-google-sso/username; the
// host carried copies with 4, 2 and 0 claude lines). Resolving relative to this
// module keeps the table and its reader in the same revision by construction; the
// two environment variables still override for deployments that relocate them.
export function deployedFile(name: string): string {
  return join(__dirname, '..', '..', '..', 'src', 'worker', 'deploy', 'acquire', name);
}

function acquisitionScopesFile(tenantId?: string | null): string {
  if (tenantId) {
    return checkedTenantFile(
      join(checkedTenantDirectory(tenantId), 'acquisition-scopes.conf'),
      'acquisition scope catalog',
    );
  }
  return process.env.SKARBIEC_WELES_ACQUISITION_SCOPES_FILE?.trim()
    || deployedFile('skarbiec-acquisition-scopes.conf');
}

// The deployed catalog and the contract table at the head of this file are one
// declaration split across two files, and nothing re-syncs the copies a host
// accumulates: this workstation carries four, at four different revisions of the
// same authored file, and a Skarbiec-side serving-path doctor already had to be
// corrected for reading the wrong one. So the copy actually in force is parsed in
// exactly one place, here, and both the reader gate and the read path below speak
// from it: two spellings of this grammar is how the copies drifted unnoticed.
// Returns every field the catalog grants this contract's own reader identity on
// this contract's item.
function managedReaderGrantedFields(
  contract: InternalAcquiredSecretContract,
  tenantId?: string | null,
): string[] {
  const readerConsumer = contract.readerConsumer;
  if (!readerConsumer) return [];
  const granted: string[] = [];
  for (const line of readFileSync(acquisitionScopesFile(tenantId), 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const columns = trimmed.split('|');
    if (columns.length !== Number('3')) continue;
    const [consumer, item, field] = columns;
    // The consumer column carries the field too, so a row counts only when it
    // names exactly this contract's reader for exactly the field it grants.
    if (item === contract.item && consumer === `${readerConsumer}-${field}`) granted.push(field);
  }
  return granted;
}

// A catalog that grants this item to its reader on a DIFFERENT field than the
// contract declares is the drift that costs the most to diagnose. Every symptom
// downstream is a credential that cannot be read, and both the reader gate and
// the acquisition helper report it as though nothing were granted at all: the
// helper names the field the contract asked for, so the row that does exist never
// appears in the refusal. Name the disagreement instead, and name the copy that is
// in force, because which catalog was read is the fact that resolves it. Null when
// there is nothing to say: an absent row and an unreadable file are different
// failures that already carry their own messages.
export function welesManagedCredentialReaderMismatch(
  secretName: string,
  field: string,
  tenantId?: string | null,
): string | null {
  const contract = resolvedAcquiredSecretContract(secretName);
  if (!contract || contract.field !== field || !contract.readerConsumer) return null;
  let catalog: string;
  let granted: string[];
  try {
    catalog = acquisitionScopesFile(tenantId);
    granted = managedReaderGrantedFields(contract, tenantId);
  } catch {
    return null;
  }
  if (!granted.length || granted.includes(field)) return null;
  return `deployed Skarbiec acquisition catalog ${catalog} grants ${contract.item}`
    + ` to its reader on ${granted.join(', ')}, but this revision's Weles credential`
    + ` contract declares field ${field}: the catalog copy in force is not the one`
    + ` this revision was built against`;
}

export function hasWelesManagedCredentialReader(
  secretName: string,
  field: string,
  tenantId?: string | null,
): boolean {
  const contract = resolvedAcquiredSecretContract(secretName);
  if (!contract || contract.field !== field || !contract.readerConsumer) return false;
  try {
    return managedReaderGrantedFields(contract, tenantId).includes(field);
  } catch {
    return false;
  }
}


export function readAcquiredField(
  consumerBase: string,
  item: string,
  field: string,
  tenantId?: string | null,
): string | undefined {
  const workloadId = process.env.SKARBIEC_WORKLOAD_ID?.trim();
  const signingKeyFile = process.env.SKARBIEC_WORKLOAD_SIGNING_KEY_FILE?.trim();
  if (!workloadId || !signingKeyFile) return undefined;
  const consumer = `${consumerBase}-${field}`;
  const helper = process.env.SKARBIEC_WELES_READER_ACQUIRE_COMMAND?.trim()
    || deployedFile('skarbiec-acquire.mjs');
  const scopeFile = acquisitionScopesFile(tenantId);
  // Resolve the authority once and pass that exact directory-owned endpoint to
  // the acquisition subprocess.
  const endpoint = skarbiecEndpoint(tenantId);
  const result = spawnSync(process.execPath, [
    helper,
    scopeFile,
    consumer,
    item,
    field,
  ], {
    encoding: 'buffer',
    maxBuffer: Number('65536'),
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: homedir(),
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      SKARBIEC_WORKLOAD_ID: workloadId,
      SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: signingKeyFile,
      WC_SKARBIEC_URL: endpoint,
    },
  });
  const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(Number('0'));
  try {
    if (result.error || result.status !== Number('0')) {
      // Repeat the authority's own words. Collapsing every refusal into one
      // sentence made an unregistered consumer, an out-of-window grant and a
      // missing scope line indistinguishable, and each needs a different fix.
      const diagnosis = (Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^\s*at\s/.test(line))
        .slice(-Number('2'))
        .join(' | ')
        .slice(Number('0'), Number('600'));
      throw new Error(
        `workload-bound Skarbiec acquisition failed for ${item}/${field} as consumer ${consumer}`
        + ` against ${endpoint}`
        + `${diagnosis ? `: ${diagnosis}` : `: helper exited ${result.status ?? 'without status'} with no diagnosis`}`,
      );
    }
    const value = output.toString('utf8').replace(/[\r\n]+$/, '');
    if (!value || /[\r\n]/.test(value) || value.includes('\0')) {
      throw new Error(`workload-bound Skarbiec acquisition returned an invalid value for ${item}/${field}`);
    }
    return value;
  } finally {
    output.fill(Number('0'));
  }
}
