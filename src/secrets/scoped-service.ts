import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const API_KEY_FIELD = Object.freeze({ api_key: true });
const LOGIN_FIELDS = Object.freeze({ username: true, password: true });
const LOGIN_WITH_TOTP_FIELDS = Object.freeze({ username: true, password: true, totp_secret: true });
const ENDPOINT_PROXY_FIELDS = Object.freeze({ username: true, password: true, host: true, ports: true });
const BASIC_PROXY_FIELDS = Object.freeze({ username: true, password: true });
const BRIGHTDATA_PROXY_FIELDS = Object.freeze({ username: true, password: true, zone: true });
const SERVICE_CONTRACTS = Object.freeze({
  googleSso: Object.freeze({ consumer: 'weles-google-sso-client', item: 'weles-google-sso-login', fields: LOGIN_FIELDS }),
  // The Claude Max pool row in the database is `Claude_controlyourai` and it has
  // its own vault item, so it must not borrow the shared googleSso login: that
  // would sign into a different Google account and mint a credential for the
  // wrong subscription.
  claudeControlYourAi: Object.freeze({ consumer: 'weles-claude-controlyourai-client', item: 'claude_controlyourai', fields: LOGIN_FIELDS }),
  // The account the fleet names claude-wisent-google-sso: the three live claude
  // subscriptions were minted by it, and its login lives in its own vault item.
  // Same field shape as the item above, which is the shape the entitlement
  // catalogue grants for a claude login (username, password).
  claudeWisentGoogleSso: Object.freeze({ consumer: 'weles-claude-wisent-google-sso-client', item: 'claude-wisent-google-sso', fields: LOGIN_FIELDS }),
  googleWorkspaceAdmin: Object.freeze({ consumer: 'weles-google-workspace-admin-client', item: 'weles-google-workspace-admin-login', fields: LOGIN_WITH_TOTP_FIELDS }),
  brightdataDashboard: Object.freeze({ consumer: 'weles-brightdata-dashboard-client', item: 'weles-brightdata-dashboard-login', fields: LOGIN_WITH_TOTP_FIELDS }),
  oxylabsDashboard: Object.freeze({ consumer: 'weles-oxylabs-dashboard-client', item: 'weles-oxylabs-dashboard-login', fields: LOGIN_WITH_TOTP_FIELDS }),
  umamiDashboard: Object.freeze({ consumer: 'weles-umami-dashboard-client', item: 'weles-umami-dashboard-login', fields: LOGIN_WITH_TOTP_FIELDS }),
  linearDashboard: Object.freeze({ consumer: 'weles-linear-dashboard-client', item: 'weles-linear-dashboard-login', fields: LOGIN_WITH_TOTP_FIELDS }),
  vastDashboard: Object.freeze({ consumer: 'weles-vast-dashboard-client', item: 'weles-vast-dashboard-login', fields: LOGIN_FIELDS }),
  supabaseDashboard: Object.freeze({ consumer: 'weles-supabase-dashboard-client', item: 'weles-supabase-dashboard-login', fields: LOGIN_FIELDS }),
  antiCaptcha: Object.freeze({ consumer: 'weles-anti-captcha-client', item: 'weles-anti-captcha-api', fields: API_KEY_FIELD }),
  twoCaptcha: Object.freeze({ consumer: 'weles-two-captcha-client', item: 'weles-two-captcha-api', fields: API_KEY_FIELD }),
  capsolver: Object.freeze({ consumer: 'weles-capsolver-client', item: 'weles-capsolver-api', fields: API_KEY_FIELD }),
  capmonster: Object.freeze({ consumer: 'weles-capmonster-client', item: 'weles-capmonster-api', fields: API_KEY_FIELD }),
  noCaptcha: Object.freeze({ consumer: 'weles-nocaptcha-client', item: 'weles-nocaptcha-api', fields: API_KEY_FIELD }),
  nopecha: Object.freeze({ consumer: 'weles-nopecha-client', item: 'weles-nopecha-api', fields: API_KEY_FIELD }),
  resendReceiving: Object.freeze({ consumer: 'weles-resend-receiving-client', item: 'weles-resend-receiving-api', fields: API_KEY_FIELD }),
  resendManagement: Object.freeze({ consumer: 'weles-resend-management-client', item: 'weles-resend-management-api', fields: API_KEY_FIELD }),
  namecheap: Object.freeze({ consumer: 'weles-namecheap-client', item: 'weles-namecheap-api', fields: Object.freeze({ api_key: true, api_user: true, username: true, client_ip: true }) }),
  juicySms: Object.freeze({ consumer: 'weles-juicysms-client', item: 'weles-juicysms-api', fields: API_KEY_FIELD }),
  oxylabsResidential: Object.freeze({ consumer: 'weles-oxylabs-residential-proxy-client', item: 'weles-oxylabs-residential-proxy', fields: BASIC_PROXY_FIELDS }),
  oxylabsMobile: Object.freeze({ consumer: 'weles-oxylabs-mobile-proxy-client', item: 'weles-oxylabs-mobile-proxy', fields: BASIC_PROXY_FIELDS }),
  brightdataProxy: Object.freeze({ consumer: 'weles-brightdata-proxy-client', item: 'weles-brightdata-proxy', fields: BRIGHTDATA_PROXY_FIELDS }),
  packetstreamProxy: Object.freeze({ consumer: 'weles-packetstream-proxy-client', item: 'weles-packetstream-proxy', fields: BASIC_PROXY_FIELDS }),
  iproyalProxy: Object.freeze({ consumer: 'weles-iproyal-proxy-client', item: 'weles-iproyal-proxy', fields: BASIC_PROXY_FIELDS }),
  iproyalMobileProxy: Object.freeze({ consumer: 'weles-iproyal-mobile-proxy-client', item: 'weles-iproyal-mobile-proxy', fields: BASIC_PROXY_FIELDS }),
  pingproxiesProxy: Object.freeze({ consumer: 'weles-pingproxies-proxy-client', item: 'weles-pingproxies-proxy', fields: BASIC_PROXY_FIELDS }),
  oxylabsIsp: Object.freeze({ consumer: 'weles-oxylabs-isp-proxy-client', item: 'weles-oxylabs-isp-proxy', fields: ENDPOINT_PROXY_FIELDS }),
  oxylabsDedicatedIsp: Object.freeze({ consumer: 'weles-oxylabs-dedicated-isp-proxy-client', item: 'weles-oxylabs-dedicated-isp-proxy', fields: ENDPOINT_PROXY_FIELDS }),
  decodoIsp: Object.freeze({ consumer: 'weles-decodo-isp-proxy-client', item: 'weles-decodo-isp-proxy', fields: ENDPOINT_PROXY_FIELDS }),
  smsActivate: Object.freeze({ consumer: 'weles-sms-activate-client', item: 'weles-sms-activate-api', fields: API_KEY_FIELD }),
} as const);

const ACQUIRED_SECRET_CONTRACTS = Object.freeze({
  'semantic_scholar.api_key': Object.freeze({
    item: 'weles-semantic-scholar-api',
    field: 'api_key',
    writerConsumer: 'weles-semantic-scholar-api-writer',
    writerTokenFile: 'weles-semantic-scholar-api-writer-skarbiec-token',
    sourceOrigin: 'https://www.semanticscholar.org',
    shape: 'semantic-scholar',
  }),
  'github.admin_org_token': Object.freeze({
    item: 'weles-github-admin-org-token',
    field: 'api_key',
    writerConsumer: 'weles-github-admin-org-token-writer',
    writerTokenFile: 'weles-github-admin-org-token-writer-skarbiec-token',
    sourceOrigin: 'https://github.com',
    shape: 'github',
  }),
  'supabase.personal_access_token': Object.freeze({
    item: 'weles-supabase-personal-access-token',
    field: 'api_key',
    writerConsumer: 'weles-supabase-personal-access-token-writer',
    writerTokenFile: 'weles-supabase-personal-access-token-writer-skarbiec-token',
    sourceOrigin: 'https://supabase.com',
    shape: 'supabase',
  }),
  'figma.personal_access_token': Object.freeze({
    item: 'weles-figma-personal-access-token',
    field: 'api_key',
    writerConsumer: 'weles-figma-personal-access-token-writer',
    writerTokenFile: 'weles-figma-personal-access-token-writer-skarbiec-token',
    sourceOrigin: 'https://www.figma.com',
    shape: 'opaque-token',
  }),
  'snapchat.snap_kit_api_token': Object.freeze({
    item: 'weles-snapchat-snap-kit-api',
    field: 'api_key',
    writerConsumer: 'weles-snapchat-snap-kit-api-writer',
    writerTokenFile: 'weles-snapchat-snap-kit-api-writer-skarbiec-token',
    sourceOrigin: 'https://kit.snapchat.com',
    shape: 'opaque-token',
  }),
} as const);

export type WelesAcquiredSecret = string;
type InternalAcquiredSecretContract = {
  item: string;
  field: string;
  writerConsumer: string;
  writerTokenFile: string;
  readerConsumer?: string;
  sourceOrigin: string;
  shape: string;
};
export type WelesAcquiredSecretContract = {
  item: string;
  field: string;
  sourceOrigin: string;
};

const MICROSOFT_PASSWORD_ID = /^weles-microsoft-[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?-password$/;
// Entra work accounts are a different provider surface from consumer Microsoft
// accounts: their password lifecycle runs at login.microsoftonline.com, never at
// account.live.com. The exact ids are enumerated so a new id cannot silently
// inherit the consumer origin. weles-microsoft-lukasz-wisent-com-password is a
// personal Microsoft account that only guests in the Entra tenant, so its
// lifecycle is the consumer one and it stays off this list.
const MICROSOFT_ENTRA_PASSWORD_IDS: ReadonlySet<string> = new Set([
  'weles-microsoft-jakub-wisent-ai-password',
]);
const MICROSOFT_ENTRA_ORIGIN = 'https://login.microsoftonline.com';
const MICROSOFT_CONSUMER_ORIGIN = 'https://account.live.com';

function resolvedAcquiredSecretContract(secret: string): InternalAcquiredSecretContract | null {
  const fixed = (ACQUIRED_SECRET_CONTRACTS as Readonly<Record<string, InternalAcquiredSecretContract>>)[secret];
  if (fixed) return fixed;
  if (!MICROSOFT_PASSWORD_ID.test(secret)) return null;
  return {
    item: secret,
    field: 'password',
    writerConsumer: `${secret}-writer`,
    writerTokenFile: `${secret}-writer-skarbiec-token`,
    readerConsumer: `${secret}-reader`,
    sourceOrigin: MICROSOFT_ENTRA_PASSWORD_IDS.has(secret)
      ? MICROSOFT_ENTRA_ORIGIN
      : MICROSOFT_CONSUMER_ORIGIN,
    shape: 'password',
  };
}

export function acquiredSecretContract(secret: string): WelesAcquiredSecretContract | null {
  const contract = resolvedAcquiredSecretContract(secret);
  return contract
    ? { item: contract.item, field: contract.field, sourceOrigin: contract.sourceOrigin }
    : null;
}

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

function tenantEndpoint(tenantId: string): string {
  const path = checkedTenantFile(join(checkedTenantDirectory(tenantId), 'skarbiec-url'), 'endpoint file');
  const value = readFileSync(path, 'utf8').trim();
  if (!value || /[\r\n]/.test(value) || value.includes(String.fromCharCode(''.length))) {
    throw new Error(`invalid tenant Skarbiec endpoint for ${tenantId}`);
  }
  return value;
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

function skarbiecEndpoint(tenantId?: string | null): string {
  const raw = tenantId ? tenantEndpoint(tenantId) : process.env.WELES_SKARBIEC_URL?.trim() ?? '';
  if (!raw) throw new Error('WELES_SKARBIEC_URL is required for exact Weles service secret resolution');
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('WELES_SKARBIEC_URL is invalid');
  }
  const loopback = endpoint.hostname === 'localhost' || endpoint.hostname === '127.0.0.1'
    || endpoint.hostname === '::1' || endpoint.hostname === '[::1]';
  if (endpoint.protocol !== 'https:' && !(loopback && endpoint.protocol === 'http:')) {
    throw new Error('WELES_SKARBIEC_URL must use HTTPS or authenticated loopback HTTP');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('WELES_SKARBIEC_URL must not contain credentials, query, or fragment');
  }
  return endpoint.toString().replace(/\/$/, '');
}

function checkedTokenFile(fileName: string, tenantId?: string | null): string | null {
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

function readScopedField(
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
function deployedFile(name: string): string {
  return join(__dirname, '..', '..', 'scripts', 'worker', 'deploy', name);
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

export function hasWelesManagedCredentialReader(
  secretName: string,
  field: string,
  tenantId?: string | null,
): boolean {
  const contract = resolvedAcquiredSecretContract(secretName);
  if (!contract || contract.field !== field || !contract.readerConsumer) return false;
  try {
    const consumer = `${contract.readerConsumer}-${field}`;
    const expected = `${consumer}|${contract.item}|${field}`;
    return readFileSync(acquisitionScopesFile(tenantId), 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .some((line) => line === expected);
  } catch {
    return false;
  }
}


function readAcquiredField(
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
  // Which authority this read is aimed at, named here so a refusal can say it: the
  // fleet runs more than one, and the fifth declaration-versus-world defect of the
  // day was a launcher exporting an authority URL nobody serves.
  const endpoint = skarbiecEndpoint(tenantId);
  const result = spawnSync(process.execPath, [
    helper,
    endpoint,
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

export function readOptionalWelesServiceSecret(serviceName: WelesServiceSecret, field: string): string | undefined {
  const service = SERVICE_CONTRACTS[serviceName];
  if (!Object.prototype.hasOwnProperty.call(service.fields, field)) {
    throw new Error(`field is not in the exact Weles service contract: ${serviceName}/${field}`);
  }
  return readAcquiredField(service.consumer, service.item, field);
}

export function readWelesManagedCredential(
  secretName: string,
  field: string,
  tenantId?: string | null,
): string | undefined {
  const contract = resolvedAcquiredSecretContract(secretName);
  if (!contract || contract.field !== field || !contract.readerConsumer) {
    throw new Error(`field is not in an exact readable Weles credential contract: ${secretName}/${field}`);
  }
  return readAcquiredField(contract.readerConsumer, contract.item, field, tenantId);
}

export interface PinnedProxyCredential {
  username: string;
  password: string;
}

export function readOptionalPinnedProxyCredential(reference: string): PinnedProxyCredential | undefined {
  const normalized = reference.toLowerCase();
  if (normalized.length !== '0000000000000000'.length || /[^a-f\d]/.test(normalized)) {
    throw new Error('invalid pinned proxy credential reference');
  }
  const username = readScopedField(
    'weles-account-proxy-client',
    'weles-account-proxy-credentials',
    'weles-account-proxy-client-skarbiec-token',
    `${normalized}_username`,
  );
  const password = readScopedField(
    'weles-account-proxy-client',
    'weles-account-proxy-credentials',
    'weles-account-proxy-client-skarbiec-token',
    `${normalized}_password`,
  );
  return username && password ? { username, password } : undefined;
}

export function readOptionalWelesServiceLogin(serviceName: WelesServiceSecret): { email: string; password: string; totpSecret?: string } | null {
  const service = SERVICE_CONTRACTS[serviceName];
  if (!Object.prototype.hasOwnProperty.call(service.fields, 'username')
      || !Object.prototype.hasOwnProperty.call(service.fields, 'password')) {
    throw new Error(`service is not an exact Weles login contract: ${serviceName}`);
  }
  const email = readOptionalWelesServiceSecret(serviceName, 'username');
  const password = readOptionalWelesServiceSecret(serviceName, 'password');
  if (!email || !password) return null;
  const totpSecret = Object.prototype.hasOwnProperty.call(service.fields, 'totp_secret')
    ? readOptionalWelesServiceSecret(serviceName, 'totp_secret')
    : undefined;
  return { email, password, ...(totpSecret ? { totpSecret } : {}) };
}

function isAllowedCredentialByte(byte: number): { allowed: boolean; letter: boolean; digit: boolean } {
  const digit = byte >= Number('48') && byte <= Number('57');
  const upper = byte >= Number('65') && byte <= Number('90');
  const lower = byte >= Number('97') && byte <= Number('122');
  const punctuation = byte === Number('46') || byte === Number('45') || byte === Number('95');
  return { allowed: digit || upper || lower || punctuation, letter: upper || lower, digit };
}

function hasPrefix(secret: Buffer, prefix: string): boolean {
  return secret.subarray(Number('0'), Buffer.byteLength(prefix)).equals(Buffer.from(prefix, 'ascii'));
}

function matchesPasswordShape(secret: Buffer): boolean {
  if (secret.length < Number('20') || secret.length > Number('128')) return false;
  let upper = false;
  let lower = false;
  let digit = false;
  let symbol = false;
  for (const byte of secret) {
    if (byte < Number('33') || byte > Number('126') || byte === Number('34') || byte === Number('92')) {
      return false;
    }
    upper ||= byte >= Number('65') && byte <= Number('90');
    lower ||= byte >= Number('97') && byte <= Number('122');
    digit ||= byte >= Number('48') && byte <= Number('57');
    symbol ||= !(
      (byte >= Number('65') && byte <= Number('90'))
      || (byte >= Number('97') && byte <= Number('122'))
      || (byte >= Number('48') && byte <= Number('57'))
    );
  }
  return upper && lower && digit && symbol;
}

function matchesAcquiredSecretShape(shape: string, secret: Buffer): boolean {
  if (shape === 'password') return matchesPasswordShape(secret);
  if (secret.length < Number('16') || secret.length > Number('8192')) return false;
  let hasLetter = false;
  let hasDigit = false;
  for (const byte of secret) {
    const kind = isAllowedCredentialByte(byte);
    if (!kind.allowed) return false;
    hasLetter ||= kind.letter;
    hasDigit ||= kind.digit;
  }
  if (shape === 'semantic-scholar') {
    return secret.length >= Number('20') && secret.length <= Number('128') && hasLetter && hasDigit;
  }
  if (shape === 'github') {
    return secret.length >= Number('24')
      && (hasPrefix(secret, 'github_pat_')
        || hasPrefix(secret, 'ghp_')
        || hasPrefix(secret, 'gho_')
        || hasPrefix(secret, 'ghu_')
        || hasPrefix(secret, 'ghs_')
        || hasPrefix(secret, 'ghr_'));
  }
  if (shape === 'opaque-token') {
    return secret.length >= Number('20') && secret.length <= Number('8192') && hasLetter && hasDigit;
  }
  return shape === 'supabase' && secret.length >= Number('16') && hasPrefix(secret, 'sbp_');
}

export function isWelesAcquiredSecretValue(secretName: WelesAcquiredSecret, secret: Buffer): boolean {
  const contract = resolvedAcquiredSecretContract(secretName);
  return Boolean(contract && matchesAcquiredSecretShape(contract.shape, secret));
}

export function writeWelesAcquiredSecret(
  secretName: WelesAcquiredSecret,
  field: string,
  secret: Buffer,
  tenantId?: string | null,
  context: { accountEmail?: string; requestId?: string; operation?: string } = {},
): void {
  const contract = resolvedAcquiredSecretContract(secretName);
  if (!contract || field !== contract.field) {
    throw new Error(`secret target is not in the exact Weles acquisition contract: ${secretName}/${field}`);
  }
  if (!isWelesAcquiredSecretValue(secretName, secret)) {
    throw new Error(`acquired value does not match the exact Weles acquisition contract: ${secretName}/${field}`);
  }
  const tokenFile = checkedTokenFile(contract.writerTokenFile, tenantId);
  if (!tokenFile) throw new Error(`required scoped Skarbiec writer token is unavailable for ${secretName}`);
  const requestId = context.requestId ?? '';
  const operation = context.operation ?? '';
  if (!/^[a-f0-9]{64}$/i.test(requestId)
      || !['acquire', 'adopt', 'rotate', 'reset', 'verify', 'rollback'].includes(operation)) {
    throw new Error(`credential write requires an exact request id and operation for ${secretName}`);
  }
  // A reset commits a value whose predecessor was never known to us, an adopt
  // commits one the operator already knew, and a rollback restores one: all
  // three only make sense for a password contract.
  if ((operation === 'rollback' || operation === 'reset' || operation === 'adopt')
      && contract.shape !== 'password') {
    throw new Error(`${operation} writes are only allowed for password contracts: ${secretName}`);
  }
  if (!isUtf8(secret)) {
    throw new Error(`credential value must be valid UTF-8 text: ${secretName}`);
  }
  const contextValue = {
    provider: contract.sourceOrigin,
    account_ref: context.accountEmail?.trim().toLowerCase() || requestId,
    request_id: requestId,
    operation,
  };
  let kind: string;
  let fields: Record<string, unknown>;
  if (contract.shape === 'password') {
    const accountEmail = context.accountEmail?.trim().toLowerCase() ?? '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(accountEmail)) {
      throw new Error(`Microsoft password write requires one valid account email for ${secretName}`);
    }
    kind = 'login';
    fields = {
      username: accountEmail,
      password: secret.toString('utf8'),
    };
  } else {
    kind = 'api-key';
    fields = {
      api_key: secret.toString('utf8'),
    };
  }
  const input = Buffer.from(JSON.stringify({
    schema: 'skarbiec.item.v2',
    kind,
    fields,
    context: contextValue,
  }), 'utf8');
  try {
    const helper = process.env.SKARBIEC_WELES_WRITER_COMMAND?.trim()
      || join(homedir(), 'weles', 'scripts', 'worker', 'deploy', 'skarbiec-write.mjs');
    const result = spawnSync(process.execPath, [
      helper,
      skarbiecEndpoint(tenantId),
      contract.writerConsumer,
      contract.item,
      contract.field,
      tokenFile,
      operation,
      requestId,
    ], {
      input,
      maxBuffer: Number('65536'),
      stdio: ['pipe', 'ignore', 'pipe'],
      env: {
        HOME: homedir(),
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      },
    });
    if (result.error || result.status !== Number('0')) {
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr.toString('utf8')
        : String(result.stderr ?? '');
      const httpStatus = stderr.match(/HTTP \d{3}/)?.[0];
      const transport = stderr.match(
        /(?:ECONNREFUSED|ECONNRESET|UND_ERR_[A-Z_]+)[^\r\n]{0,160}/,
      )?.[0];
      const safeReason = stderr.match(/Error: ([^\r\n]{1,240})/)?.[1]
        ?.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
      const detail = httpStatus ?? transport ?? safeReason ?? 'without diagnostic detail';
      throw new Error(
        `scoped Skarbiec write failed for ${secretName}/${field} via ${skarbiecEndpoint(tenantId)}: ${detail}`,
      );
    }
  } finally {
    input.fill(Number('0'));
  }
}
