// Weles's scoped Skarbiec credentials: the reads each service and managed
// credential contract grants, and, from scoped-service/acquired/, the shape
// check and the write of a credential a browser job acquired.

import {
  SERVICE_CONTRACTS,
  resolvedAcquiredSecretContract,
} from './scoped-service/contracts.js';
import {
  readScopedField,
  readAcquiredField,
} from './scoped-service/transport.js';
import { welesManagedCredentialReaderMismatch } from './scoped-service/transport/grants.js';
import { SkarbiecAcquisitionError } from './scoped-service/acquisition-failure.js';
import type { WelesServiceSecret } from './scoped-service/transport.js';
export {
  acquiredSecretContract,
  isWelesAcquiredSourceOrigin,
  isWelesManagedPasswordItem,
} from './scoped-service/contracts.js';
export type {
  WelesAcquiredSecret,
  WelesAcquiredSecretContract,
} from './scoped-service/contracts.js';
export { hasWelesAcquiredSecretWriter } from './scoped-service/transport.js';
export {
  hasWelesManagedCredentialReader,
  welesManagedCredentialReaderMismatch,
} from './scoped-service/transport/grants.js';
export type { WelesServiceSecret } from './scoped-service/transport.js';
export { isWelesAcquiredSecretValue } from './scoped-service/acquired/value.js';
export { writeWelesAcquiredSecret } from './scoped-service/acquired/write.js';

export function readOptionalWelesServiceSecret(
  serviceName: WelesServiceSecret,
  field: string,
): string | undefined {
  const service = SERVICE_CONTRACTS[serviceName];
  if (!Object.prototype.hasOwnProperty.call(service.fields, field)) {
    throw new Error(
      `field is not in the exact Weles service contract: ${serviceName}/${field}`,
    );
  }
  // A service credential is the item playing the role the contract names, so
  // the catalog and Skarbiec are asked for role:<role> and no item is named.
  return readAcquiredField(
    service.consumer,
    service.item,
    field,
    null,
    `role:${service.item}`,
  );
}

export function readWelesManagedCredential(
  secretName: string,
  field: string,
  tenantId?: string | null,
): string | undefined {
  const contract = resolvedAcquiredSecretContract(secretName);
  if (!contract || contract.field !== field || !contract.readerConsumer) {
    throw new Error(
      `field is not in an exact readable Weles credential contract: ${secretName}/${field}`,
    );
  }
  // Before the helper is spawned, because its refusal names only the field this
  // contract asked for and so reads as "nothing is granted" when the catalog in
  // force grants the same item on another field.
  const mismatch = welesManagedCredentialReaderMismatch(
    secretName,
    field,
    tenantId,
  );
  if (mismatch) throw new Error(mismatch);
  return readAcquiredField(
    contract.readerConsumer,
    contract.item,
    field,
    tenantId,
  );
}

export interface PinnedProxyCredential {
  username: string;
  password: string;
}

/**
 * The account-pinned proxy login a pin's credential_ref names: the
 * <ref>_username and <ref>_password fields of the account-proxy credentials
 * item. A reference is lowercase hexadecimal; any other is refused.
 */
export function readOptionalPinnedProxyCredential(
  reference: string,
): PinnedProxyCredential | undefined {
  const normalized = reference.toLowerCase();
  if (!/^[a-f\d]+$/.test(normalized)) {
    throw new Error(
      `invalid pinned proxy credential reference ${JSON.stringify(reference)}: a reference is hexadecimal`,
    );
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

export function readOptionalWelesServiceLogin(
  serviceName: WelesServiceSecret,
): { email: string; password: string; totpSecret?: string } | null {
  const service = SERVICE_CONTRACTS[serviceName];
  if (
    !Object.prototype.hasOwnProperty.call(service.fields, 'username') ||
    !Object.prototype.hasOwnProperty.call(service.fields, 'password')
  ) {
    throw new Error(
      `service is not an exact Weles login contract: ${serviceName}`,
    );
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
      if (
        !(error instanceof SkarbiecAcquisitionError) ||
        error.reason !== 'field_not_present'
      )
        throw error;
    }
  }
  return { email, password, ...(totpSecret ? { totpSecret } : {}) };
}
