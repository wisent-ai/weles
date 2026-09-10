import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_CONTRACTS, resolvedAcquiredSecretContract, isWelesAcquiredSourceOrigin } from './scoped-service/contracts.js';
import type { WelesAcquiredSecret } from './scoped-service/contracts.js';
import { checkedTokenFile, skarbiecEndpoint, readScopedField, readAcquiredField, deployedFile,
  welesManagedCredentialReaderMismatch } from './scoped-service/transport.js';
import type { WelesServiceSecret } from './scoped-service/transport.js';
export { acquiredSecretContract, isWelesAcquiredSourceOrigin, isWelesManagedPasswordItem } from './scoped-service/contracts.js';
export type { WelesAcquiredSecret, WelesAcquiredSecretContract } from './scoped-service/contracts.js';
export { hasWelesAcquiredSecretWriter, hasWelesManagedCredentialReader, welesManagedCredentialReaderMismatch } from './scoped-service/transport.js';
export type { WelesServiceSecret } from './scoped-service/transport.js';



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
  // Before the helper is spawned, because its refusal names only the field this
  // contract asked for and so reads as "nothing is granted" when the catalog in
  // force grants the same item on another field.
  const mismatch = welesManagedCredentialReaderMismatch(secretName, field, tenantId);
  if (mismatch) throw new Error(mismatch);
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

function isMissingOptionalAcquisitionField(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('acquisition field does not exist on item')
    || message.includes('canonical item has no field:');
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
  let totpSecret: string | undefined;
  if (Object.prototype.hasOwnProperty.call(service.fields, 'totp_secret')) {
    try {
      totpSecret = readOptionalWelesServiceSecret(serviceName, 'totp_secret');
    } catch (error) {
      // TOTP is optional login material. Only a definitive answer that this
      // item's field does not exist may omit it; grant, identity and authority
      // failures still stop before a browser opens.
      if (!isMissingOptionalAcquisitionField(error)) throw error;
    }
  }
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
  context: {
    accountEmail?: string;
    requestId?: string;
    operation?: string;
    sourceOrigin?: string;
    declaredOrigin?: string;
  } = {},
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
  // The provenance this write claims is the origin the value was captured on. A
  // table contract pins it; a derived contract has none to pin, so the caller
  // must state the captured origin and it must be one absolute https origin —
  // Skarbiec matches it against the signup origin recorded for the operation.
  const capturedOrigin = contract.sourceOrigin ?? context.sourceOrigin ?? '';
  if (!isWelesAcquiredSourceOrigin(capturedOrigin)) {
    throw new Error(`credential write requires one exact captured https origin for ${secretName}`);
  }
  // Skarbiec records the signup origin a generic acquire declared and refuses the
  // managed write unless the body echoes exactly that string; it equally refuses a
  // capture origin presented for an operation that declared none, so the key
  // travels only when one was declared and only as the exact recorded value.
  const declaredOrigin = context.declaredOrigin ?? '';
  if (declaredOrigin && declaredOrigin !== capturedOrigin) {
    throw new Error(`captured origin does not match the declared signup origin for ${secretName}`);
  }
  const contextValue = {
    provider: capturedOrigin,
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
    ...(declaredOrigin ? { capture_origin: declaredOrigin } : {}),
  }), 'utf8');
  try {
    const helper = process.env.SKARBIEC_WELES_WRITER_COMMAND?.trim()
      || deployedFile('skarbiec-write.mjs');
    const result = spawnSync(process.execPath, [
      helper,
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
        WC_SKARBIEC_URL: skarbiecEndpoint(tenantId),
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
