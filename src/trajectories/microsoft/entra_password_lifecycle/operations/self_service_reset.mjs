// Self-service reset: the operation that accepts an unknown current password.
//
// Reset never holds the current password, so the pre-write proof is the
// directory binding of the UPN domain; the full tid + oid + UPN assertion runs
// on the fresh login before anything reaches Skarbiec, and every interactive
// verification step is handed to a human. Because no previous value is known,
// nothing here has a compensating rollback: a reset that cannot be proven
// quarantines the item.
//
// The two ways the domain proof can be missing are different answers. A domain
// that resolves to another tenant is a refusal of this contract; a discovery
// document this run could not read proves nothing about the tenant and is a
// retryable unverified identity.
//
// Moved out of entra_password_lifecycle.mjs, which keeps the three trajectory
// entry points.

import { outcome } from '../answer_and_custody.mjs';
import { commitAfterFreshLogin } from '../authorized_session.mjs';
import { openSelfServiceReset, submitResetPasswordForm } from '../directory_password.mjs';
import { tenantOfUpnDomain } from '../proven_identity.mjs';

export async function resetDirectoryPassword(session, account, contract, plan) {
  const { nextPassword, sink, proxyUrl, evidence } = plan;
  const domain = await tenantOfUpnDomain(contract.accountUpn);
  if (!domain.ok) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ENTRA_IDENTITY_UNVERIFIED',
      phase: 'identity_verification',
      retryable: true,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: domain.reason,
    });
  }
  if (domain.tenantId !== contract.tenantId) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ENTRA_IDENTITY_MISMATCH',
      phase: 'identity_verification',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the UPN domain does not resolve to the requested Entra tenant',
    });
  }
  evidence.push('identity_verification:upn_domain_tenant_confirmed');
  const surface = await openSelfServiceReset(session, contract);
  if (surface === 'identity_verification_required') {
    return outcome(contract, {
      status: 'needs_human_approval',
      code: 'ENTRA_RESET_REQUIRES_HUMAN_VERIFICATION',
      phase: 'identity_verification',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the Entra self-service reset requires interactive identity verification',
    });
  }
  if (surface === 'not_eligible') {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ENTRA_RESET_NOT_ELIGIBLE',
      phase: 'password_change',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the Entra directory refused a self-service reset for this account',
    });
  }
  if (surface !== 'password_form') {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ENTRA_RESET_SURFACE_UNAVAILABLE',
      phase: 'password_change',
      retryable: true,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the Entra self-service reset did not present a new-password form',
    });
  }
  const submitted = await submitResetPasswordForm(session, nextPassword);
  evidence.push(`password_change:${submitted}`);
  if (submitted !== 'changed') {
    // A rejected reset never reached the directory; anything else leaves the
    // reset password unproven, and reset has no known value to roll back to.
    return outcome(contract, {
      status: 'operation_failed',
      code: submitted === 'rejected' ? 'ENTRA_RESET_REJECTED' : 'ENTRA_RESET_AMBIGUOUS',
      phase: 'password_change',
      retryable: submitted === 'rejected',
      providerEffect: submitted === 'rejected' ? 'none' : 'unknown',
      rollbackStatus: 'none',
      reason: submitted === 'rejected'
        ? 'the Entra directory rejected the reset password'
        : 'the Entra reset outcome is ambiguous and the previous password is unknown',
    });
  }
  const resetAt = new Date().toISOString();
  const reset = await commitAfterFreshLogin(
    session,
    account,
    contract,
    {
      password: nextPassword,
      writeOperation: 'reset',
      sink,
      proxyUrl,
      providerEffect: 'changed',
      evidence,
    },
  );
  if (reset.answer) return reset.answer;
  if (!reset.committed) {
    // No known previous password means no compensating provider rollback.
    return outcome(contract, {
      status: 'operation_failed',
      code: 'SKARBIEC_COMMIT_FAILED',
      phase: 'skarbiec_commit',
      retryable: false,
      providerEffect: 'changed',
      rollbackStatus: 'none',
      reason: 'the Entra reset succeeded but the Skarbiec commit failed and no rollback value exists',
    });
  }
  return outcome(contract, {
    status: 'operation_completed',
    providerEffect: 'changed',
    rollbackStatus: 'none',
    changedAt: resetAt,
    evidence,
    reason: 'the Entra password was reset, re-authenticated, and committed to Skarbiec',
  });
}
