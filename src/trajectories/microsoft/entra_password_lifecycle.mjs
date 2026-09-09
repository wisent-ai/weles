// Microsoft Entra ID (work/school directory) password lifecycle.
//
// Entra sibling of password_lifecycle.mjs. Consumer Microsoft-account surfaces do
// not administer directory identities, so every surface used here is Entra-owned:
//   sign-in              https://login.microsoftonline.com
//   authorized context   https://myaccount.microsoft.com
//   password change      https://account.activedirectory.windowsazure.com/ChangePassword.aspx
//   self-service reset   https://passwordreset.microsoftonline.com
//
// Identity is never inferred from the credential id, the queued account row, or
// page copy. The trajectory reads the tokens that the first-party My Account SPA
// mints for the signed-in session (MSAL cache plus the Authorization headers the
// SPA sends) and requires the documented Entra claims tid, oid and
// preferred_username/upn to equal the queued contract before any password write
// and again after the fresh login that precedes the Skarbiec commit. Absent,
// conflicting or unreadable claims fail closed; no password is ever written to a
// log, a result payload, or a recording.
//
// adopt, rotate and reset are deliberately separate: adopt proves a password the
// operator already knows and never writes to the directory, rotate demands the
// known managed password (so a compensating rollback exists), and reset accepts
// an unknown current password but hands every interactive identity verification
// to a human instead of pretending to satisfy it.
//
// Every terminal answer states one three-valued provider effect: 'none' when the
// directory password was left untouched, 'changed' when the directory accepted a
// new value, and 'unknown' when this run cannot prove which value the directory
// now holds. Only 'none' may be retried automatically; 'unknown' quarantines the
// item. A successful run also carries a receipt naming the exact principal that
// was proven, digesting the session evidence without any password material.
//
// This file keeps the three trajectory entry points and the admission every one
// of them shares: the exact Skarbiec contract, the account row bound to it, the
// credential read, and the single browser session the phases run in. The phases
// themselves live in entra_password_lifecycle/:
//   queued_job              the contract, the account row, and the Entra surfaces
//   answer_and_custody      the terminal answer, its resources, and the secret
//   proven_identity         the token claims and the hard identity gate
//   authorized_session      the sign-in walk and the commit behind it
//   directory_password      the change and reset surfaces plus the restore
//   operations/             one file per operation this trajectory offers

import {
  generatedPassword,
  managedPassword,
  outcome,
} from './entra_password_lifecycle/answer_and_custody.mjs';
import { rotateDirectoryPassword } from './entra_password_lifecycle/operations/rotation.mjs';
import { resetDirectoryPassword } from './entra_password_lifecycle/operations/self_service_reset.mjs';
import {
  proveStagedCandidate,
  verifyManagedPassword,
} from './entra_password_lifecycle/operations/verification_and_adoption.mjs';
import { clearBearerTokens, trackBearerTokens } from './entra_password_lifecycle/proven_identity.mjs';
import { constraints, openSession, queuedAccount } from './entra_password_lifecycle/queued_job.mjs';

// Every operation runs its phases inside one browser session, and the answer
// those phases produced is the run's product: it already names the provider
// effect and is already published to the run recording. Releasing the session
// can fail on its own, and that failure is never allowed to overwrite the
// answer. On the failing path the release failure is folded into the error that
// was already travelling, so neither the cause nor the leaked session is lost;
// on the answering path it is reported to the run log, which is where an
// operator looks for a browser this host did not shut down.
async function withEntraSession(account, label, run) {
  const { session, proxyUrl } = await openSession(account, label);
  const bearerTokens = [];
  trackBearerTokens(session.page, bearerTokens);
  let answer;
  try {
    answer = await run({ session, proxyUrl, sink: bearerTokens });
  } catch (error) {
    clearBearerTokens(bearerTokens);
    try {
      await session.close();
    } catch (closeError) {
      throw new Error(
        `${label} failed: ${error.message}; and its browser session stayed open: ${closeError.message}`,
        { cause: error },
      );
    }
    throw error;
  }
  clearBearerTokens(bearerTokens);
  try {
    await session.close();
  } catch (closeError) {
    console.error(`${label} answered ${answer.status} and its browser session stayed open: ${closeError.message}`);
  }
  return answer;
}

export async function resetEntraPassword() {
  const contract = constraints(['rotate', 'reset']);
  const evidence = [];
  const account = await queuedAccount(contract);
  if (!account) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ENTRA_ACCOUNT_BINDING_MISMATCH',
      phase: 'admission',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the queued account row is not bound to the requested Entra identity and managed credential',
    });
  }
  evidence.push('admission:account_bound');
  const currentPassword = managedPassword(contract);
  if (contract.operation === 'rotate' && !currentPassword) {
    return outcome(contract, {
      status: 'needs_human_approval',
      code: 'ROTATE_REQUIRES_KNOWN_PASSWORD',
      phase: 'credential_read',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'rotation requires the known managed Entra password so a compensating rollback stays possible',
    });
  }
  const nextPassword = generatedPassword();
  return withEntraSession(
    account,
    'microsoft_entra_reset_password',
    ({ session, proxyUrl, sink }) => (contract.operation === 'reset'
      ? resetDirectoryPassword(session, account, contract, { nextPassword, sink, proxyUrl, evidence })
      : rotateDirectoryPassword(
        session,
        account,
        contract,
        { currentPassword, nextPassword, sink, proxyUrl, evidence },
      )),
  );
}

export async function verifyEntraPassword() {
  const contract = constraints(['verify']);
  const evidence = [];
  const account = await queuedAccount(contract);
  if (!account) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ENTRA_ACCOUNT_BINDING_MISMATCH',
      phase: 'admission',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the queued account row is not bound to the requested Entra identity and managed credential',
    });
  }
  evidence.push('admission:account_bound');
  const password = managedPassword(contract);
  if (!password) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'MANAGED_PASSWORD_UNAVAILABLE',
      phase: 'credential_read',
      retryable: true,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the managed Entra password is unavailable from Skarbiec',
    });
  }
  evidence.push('credential_read:managed_password');
  return withEntraSession(
    account,
    'microsoft_entra_verify_password',
    ({ session, proxyUrl, sink }) => verifyManagedPassword(
      session,
      account,
      contract,
      { password, sink, proxyUrl, evidence },
    ),
  );
}

export async function adoptEntraPassword() {
  const contract = constraints(['adopt']);
  const evidence = [];
  const account = await queuedAccount(contract);
  if (!account) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ENTRA_ACCOUNT_BINDING_MISMATCH',
      phase: 'admission',
      retryable: false,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the queued account row is not bound to the requested Entra identity and managed credential',
    });
  }
  evidence.push('admission:account_bound');
  const candidate = managedPassword(contract);
  if (!candidate) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'ADOPT_CANDIDATE_UNAVAILABLE',
      phase: 'credential_read',
      retryable: true,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the staged Entra password candidate for this request is unavailable from Skarbiec',
    });
  }
  evidence.push('credential_read:staged_candidate');
  return withEntraSession(
    account,
    'microsoft_entra_adopt_password',
    ({ session, proxyUrl, sink }) => proveStagedCandidate(
      session,
      account,
      contract,
      { candidate, sink, proxyUrl, evidence },
    ),
  );
}
