import { updateAccount } from '../../../../dist/state/skarbiec-records.js';
import { writeWelesAcquiredSecret } from '../../../../dist/secrets/scoped-service.js';
import { PASSWORD_FIELD } from './constants.mjs';
import { rollbackPassword } from './operations.mjs';

/** Write one password revision to Skarbiec under the contract, wiping the buffer afterwards. */
export function writePasswordSecret(contract, password, operation) {
  const secret = Buffer.from(password, 'utf8');
  try {
    writeWelesAcquiredSecret(
      contract.credentialId,
      PASSWORD_FIELD,
      secret,
      contract.tenantId,
      {
        accountEmail: contract.accountEmail,
        requestId: contract.requestId,
        operation,
      },
    );
  } finally {
    Reflect.apply(Buffer.prototype.fill, secret, [0]);
  }
}

/** Point the account at its Skarbiec credential and drop any password it still carried. */
export function updateAccountReference(account, credentialId, tenantId) {
  if (!account.id) throw new Error('Microsoft account has no stable Skarbiec id');
  const metadata = { ...(account.metadata ?? {}), skarbiec_credential_id: credentialId };
  delete metadata.password;
  if (tenantId) metadata.skarbiec_tenant_id = tenantId;
  else delete metadata.skarbiec_tenant_id;
  if (!updateAccount(account.id, { metadata })) {
    throw new Error('Microsoft account credential-reference update failed');
  }
}

/**
 * Commit the rotated password to Skarbiec and the account reference. When
 * that commit fails, the provider is rolled back to the current password; if
 * the provider cannot be rolled back, the commit is tried once more so the
 * two sides agree; if it can, Skarbiec is restored to the previous password
 * too. Every outcome other than agreement throws with the cause attached.
 */
export async function commitRotatedPassword({ contract, account, nextPassword, currentPassword, session }) {
  try {
    writePasswordSecret(contract, nextPassword, contract.operation);
    updateAccountReference(account, contract.credentialId, contract.tenantId);
    return;
  } catch (error) {
    const providerRolledBack = await rollbackPassword(session, contract.accountEmail, nextPassword, currentPassword);
    if (!providerRolledBack) {
      try {
        writePasswordSecret(contract, nextPassword, contract.operation);
        updateAccountReference(account, contract.credentialId, contract.tenantId);
        return;
      } catch (forwardError) {
        throw new Error('credential commit and Microsoft rollback both failed; automatic consistency recovery failed', {
          cause: forwardError,
        });
      }
    }
    let skarbiecRolledBack = false;
    try {
      writePasswordSecret(contract, currentPassword, 'rollback');
      skarbiecRolledBack = true;
    } catch (rollbackError) {
      console.log(`[microsoft] Skarbiec rollback failed: ${String(rollbackError?.message ?? rollbackError).slice(0, 120)}`);
    }
    if (!skarbiecRolledBack) {
      throw new Error('credential commit failed and compensating rollback did not restore both Microsoft and Skarbiec', {
        cause: error,
      });
    }
    throw new Error('credential commit failed; Microsoft and Skarbiec were restored to the previous password', {
      cause: error,
    });
  }
}
