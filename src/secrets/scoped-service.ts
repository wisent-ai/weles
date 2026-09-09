// The Weles scoped credential surface: what a session may read from Skarbiec,
// and the one write path that commits a captured credential back.
//
// The file grew past the line limit, so the family under `scoped-service/`
// holds the declarations, the authority, the deployed catalogue, the reads and
// the shape gate. What stays here is the write: the operation that needs every
// one of them at once, and the only place in Weles that hands a captured
// secret to the authority.

import { isUtf8 } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { checkedTokenFile, skarbiecEndpoint } from './scoped-service/authority';
import {
  isWelesAcquiredSourceOrigin,
  resolvedAcquiredSecretContract,
} from './scoped-service/contracts';
import { isWelesAcquiredSecretValue } from './scoped-service/shapes';

export {
  acquiredSecretContract,
  isWelesAcquiredSourceOrigin,
  isWelesManagedPasswordItem,
  type WelesAcquiredSecret,
  type WelesAcquiredSecretContract,
  type WelesServiceSecret,
} from './scoped-service/contracts';
export {
  hasWelesAcquiredSecretWriter,
  hasWelesManagedCredentialReader,
  welesManagedCredentialReaderMismatch,
} from './scoped-service/catalog';
export {
  readOptionalPinnedProxyCredential,
  readOptionalWelesServiceLogin,
  readOptionalWelesServiceSecret,
  readWelesManagedCredential,
  type PinnedProxyCredential,
} from './scoped-service/reads';
export { isWelesAcquiredSecretValue } from './scoped-service/shapes';

import type { WelesAcquiredSecret } from './scoped-service/contracts';

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
      || join(homedir(), 'weles', 'scripts', 'worker', 'deploy', 'skarbiec-write.mjs');
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
