// Where Skarbiec answers for this machine, and which files may be used to
// speak to it.
//
// Moved verbatim out of the single scoped-service file during a split by
// responsibility, with one repair: an unreadable token file used to be
// reported as an absent one. Absence is an answer this surface gives all the
// time — a service without a scoped token is simply unavailable — but a file
// that exists and cannot be read is a misconfiguration, and returning the same
// null for both hid it behind "no writer available".

import { constants as fsConstants, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const TENANT_HEX_RE = /^[a-f\d-]+$/i;
const TENANT_PART_LENGTHS = Object.freeze([
  'xxxxxxxx'.length,
  'xxxx'.length,
  'xxxx'.length,
  'xxxx'.length,
  'xxxxxxxxxxxx'.length,
]);

export function checkedTenantDirectory(tenantId: string): string {
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

export function checkedTenantFile(path: string, label: string): string {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & (fsConstants.S_IRWXG | fsConstants.S_IRWXO)) !== ''.length) {
    throw new Error(`refusing unsafe tenant Skarbiec ${label}`);
  }
  return path;
}

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

/// Is this the error the filesystem raises for a path that is not there?
function isAbsentPath(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === 'ENOENT';
}

export function checkedTokenFile(fileName: string, tenantId?: string | null): string | null {
  const path = tenantId
    ? join(checkedTenantDirectory(tenantId), fileName)
    : join(homedir(), '.stado', fileName);
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    // No token file is a real answer: the service is not enabled here. Any
    // other reason the path could not be examined is a fault of this machine,
    // and it says so instead of reading as "not enabled".
    if (isAbsentPath(error)) return null;
    throw new Error(
      `scoped Skarbiec token file could not be examined at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const unsafeBits = Number.parseInt('77', Number('8'));
  if (!metadata.isFile() || metadata.isSymbolicLink()
    || (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
    || (metadata.mode & unsafeBits) !== Number('0')) {
    throw new Error(`refusing unsafe scoped Skarbiec token file for ${fileName}`);
  }
  return path;
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
  return join(__dirname, '..', '..', '..', 'scripts', 'worker', 'deploy', name);
}

export function acquisitionScopesFile(tenantId?: string | null): string {
  if (tenantId) {
    return checkedTenantFile(
      join(checkedTenantDirectory(tenantId), 'acquisition-scopes.conf'),
      'acquisition scope catalog',
    );
  }
  return process.env.SKARBIEC_WELES_ACQUISITION_SCOPES_FILE?.trim()
    || deployedFile('skarbiec-acquisition-scopes.conf');
}
