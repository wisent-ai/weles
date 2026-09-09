// Every read path: the scoped field read through the fleet binary, the
// workload-bound acquisition through the deploy helper, and the three shapes a
// caller asks for — one service field, a full login, a pinned proxy pair.
//
// Moved verbatim out of the single scoped-service file during a split by
// responsibility.

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { acquisitionScopesFile, checkedTokenFile, deployedFile, skarbiecEndpoint } from './authority';
import { welesManagedCredentialReaderMismatch } from './catalog';
import { resolvedAcquiredSecretContract, SERVICE_CONTRACTS, type WelesServiceSecret } from './contracts';

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
