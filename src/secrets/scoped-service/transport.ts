import { spawnSync } from 'node:child_process';
import { constants as fsConstants, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolvedAcquiredSecretContract, SERVICE_CONTRACTS } from './contracts.js';
import type { InternalAcquiredSecretContract } from './contracts.js';
import { acquisitionStderr, SkarbiecAcquisitionError } from './acquisition-failure.js';
import { localCredentialsFile, readLocalField } from './local-file.js';
const TENANT_HEX_RE = /^[a-f\d-]+$/i;
const TENANT_PART_LENGTHS = Object.freeze([8, 4, 4, 4, 12]);

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
    || (metadata.mode & (fsConstants.S_IRWXG | fsConstants.S_IRWXO)) !== 0) {
    throw new Error(`refusing unsafe tenant Skarbiec binding directory for ${tenantId}`);
  }
  return directory;
}

function checkedTenantFile(path: string, label: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & (fsConstants.S_IRWXG | fsConstants.S_IRWXO)) !== 0) {
    throw new Error(`refusing unsafe tenant Skarbiec ${label}`);
  }
  return path;
}


export function hasWelesAcquiredSecretWriter(secret: string, tenantId?: string | null): boolean {
  const contract = resolvedAcquiredSecretContract(secret);
  if (!contract) return false;
  if (localCredentialsFile()) return true;
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
  if (!raw) throw new Error('WC_SKARBIEC_URL is required from the Stado service directory; without Skarbiec set WELES_CREDENTIALS_FILE to an owner-only credentials file');
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
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & 0o077) !== 0) {
    throw new Error(`refusing unsafe scoped Skarbiec token file for ${fileName}`);
  }
  return path;
}

/** The `stado` command group that reads credential fields. */
const CREDENTIALS_GROUP = 'credentials';

/**
 * One field of the item playing role `role`, read with the consumer's own
 * grant (`read:role:<role>#<field>`). The local credentials file keys the
 * fields by the role name.
 */
export function readScopedField(
  consumer: string,
  role: string,
  tokenFileName: string,
  field: string,
): string | undefined {
  const local = localCredentialsFile();
  if (local) return readLocalField(local, role, field);
  const tokenFile = checkedTokenFile(tokenFileName);
  if (!tokenFile) return undefined;
  const binary = process.env.WELES_STADO_BIN?.trim() || join(homedir(), '.stado', 'bin', 'stado');
  const result = spawnSync(binary, [CREDENTIALS_GROUP, 'get', '--role', role, '--field', field], {
    encoding: 'buffer',
    maxBuffer: Infinity,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: homedir(),
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      WC_SKARBIEC_URL: skarbiecEndpoint(),
      WC_SKARBIEC_CONSUMER: consumer,
      WC_SKARBIEC_TOKEN_FILE: tokenFile,
    },
  });
  const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  try {
    if (result.error || result.status !== 0) {
      throw new Error(`scoped Skarbiec read failed for role ${role}/${field}`);
    }
    const value = output.toString('utf8').replace(/[\r\n]+$/, '');
    if (!value || /[\r\n]/.test(value) || value.includes(String.fromCharCode(0))) {
      throw new Error(`scoped Skarbiec returned an invalid value for role ${role}/${field}`);
    }
    return value;
  } finally {
    output.fill(0);
  }
}
// Helpers and the public service catalog come from the executing release.
// Deployment-owned scope catalogs can be selected explicitly.
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

// Read the catalog actually selected by this deployment. Each grant must name
// this contract's exact reader identity, item and field.
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
    if (columns.length !== 3) continue;
    const [consumer, item, field] = columns;
    // The consumer column carries the field too, so a row counts only when it
    // names exactly this contract's reader for exactly the field it grants.
    if (item === contract.item && consumer === `${readerConsumer}-${field}`) granted.push(field);
  }
  return granted;
}

// Distinguish a missing reader grant from a grant for a different field.
// Report the selected catalog so a deployment can correct the active input.
export function welesManagedCredentialReaderMismatch(
  secretName: string,
  field: string,
  tenantId?: string | null,
): string | null {
  const contract = resolvedAcquiredSecretContract(secretName);
  if (!contract || contract.field !== field || !contract.readerConsumer) return null;
  if (localCredentialsFile()) return null;
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
    + ` to its reader on ${granted.join(', ')}, but the selected Weles credential`
    + ` contract declares field ${field}`;
}

export function hasWelesManagedCredentialReader(
  secretName: string,
  field: string,
  tenantId?: string | null,
): boolean {
  const contract = resolvedAcquiredSecretContract(secretName);
  if (!contract || contract.field !== field || !contract.readerConsumer) return false;
  if (localCredentialsFile()) return true;
  try {
    return managedReaderGrantedFields(contract, tenantId).includes(field);
  } catch {
    return false;
  }
}


/**
 * Acquire one field through the workload-bound helper. `item` keys the local
 * credentials file; `coordinate` is what the acquisition catalog and Skarbiec
 * are asked for: the item itself, or `role:<role>` for a credential named by
 * the role its item plays.
 */
export function readAcquiredField(
  consumerBase: string,
  item: string,
  field: string,
  tenantId?: string | null,
  coordinate: string = item,
): string | undefined {
  const local = localCredentialsFile();
  if (local) return readLocalField(local, item, field, tenantId);
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
    coordinate,
    field,
  ], {
    encoding: 'buffer',
    maxBuffer: Infinity,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      HOME: homedir(),
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      SKARBIEC_WORKLOAD_ID: workloadId,
      SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: signingKeyFile,
      WC_SKARBIEC_URL: endpoint,
    },
  });
  const output = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  try {
    if (result.error || result.status !== 0) {
      // Repeat the authority's own words. Collapsing every refusal into one
      // sentence made an unregistered consumer, an out-of-window grant and a
      // missing scope line indistinguishable, and each needs a different fix.
      const { reason, lines } = acquisitionStderr(
        Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : '',
      );
      const diagnosis = lines.join(' | ');
      throw new SkarbiecAcquisitionError(
        `workload-bound Skarbiec acquisition failed for ${coordinate}/${field} as consumer ${consumer}`
        + ` against ${endpoint}`
        + `${diagnosis ? `: ${diagnosis}` : `: helper exited ${result.status ?? 'without status'} with no diagnosis`}`,
        { item: coordinate, field, consumer },
        reason,
      );
    }
    const value = output.toString('utf8').replace(/[\r\n]+$/, '');
    if (!value || /[\r\n]/.test(value) || value.includes('\0')) {
      throw new Error(`workload-bound Skarbiec acquisition returned an invalid value for ${coordinate}/${field}`);
    }
    return value;
  } finally {
    output.fill(0);
  }
}
