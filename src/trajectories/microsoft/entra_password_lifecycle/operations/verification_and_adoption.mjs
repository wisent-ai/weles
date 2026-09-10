// The two operations that never write to the directory.
//
// verify proves that the password Skarbiec already manages still authenticates
// and rewrites that same value under a 'verify' provenance, so the directory is
// left exactly as it was found.
//
// adopt takes over a password the operator already knows. Skarbiec stages that
// candidate under the item, bound to this request id; this run reads the staged
// value through the scoped managed-credential reader, proves it against the
// directory with a fresh login and the full tid + oid + UPN assertion, and
// reports a verdict. Skarbiec activates the staged revision itself on
// operation_completed, so Weles writes nothing here and never touches the value
// the directory holds: the provider effect is always 'none'.
//
// Moved out of entra_password_lifecycle.mjs, which keeps the three trajectory
// entry points.

import { persistFreshCookieJar } from '../../../_shared/auth/cookie-freshness.mjs';
import { outcome } from '../answer_and_custody.mjs';
import { commitAfterFreshLogin, signIn } from '../authorized_session.mjs';
import { assertEntraIdentity } from '../proven_identity.mjs';

export async function verifyManagedPassword(session, account, contract, plan) {
  const { password, sink, proxyUrl, evidence } = plan;
  const verified = await commitAfterFreshLogin(
    session,
    account,
    contract,
    {
      password,
      writeOperation: 'verify',
      sink,
      proxyUrl,
      providerEffect: 'none',
      evidence,
    },
  );
  if (verified.answer) {
    return outcome(contract, {
      ...verified.answer,
      reason: verified.answer.message,
      providerEffect: 'none',
      rollbackStatus: 'none',
    });
  }
  if (!verified.committed) {
    return outcome(contract, {
      status: 'operation_failed',
      code: 'SKARBIEC_COMMIT_FAILED',
      phase: 'skarbiec_commit',
      retryable: true,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: 'the verified Entra password could not be rewritten to Skarbiec',
    });
  }
  return outcome(contract, {
    status: 'operation_completed',
    providerEffect: 'none',
    rollbackStatus: 'none',
    changedAt: null,
    evidence,
    reason: 'the managed Entra password authenticated freshly and was rewritten unchanged',
  });
}

export async function proveStagedCandidate(session, account, contract, plan) {
  const { candidate, sink, proxyUrl, evidence } = plan;
  const signedIn = await signIn(session, contract, candidate);
  evidence.push(`fresh_login_verification:${signedIn}`);
  if (signedIn !== 'authenticated') {
    return outcome(contract, {
      status: signedIn === 'identity_challenge' ? 'needs_human_approval' : 'operation_failed',
      code: signedIn === 'identity_challenge'
        ? 'ADOPT_REQUIRES_HUMAN_APPROVAL'
        : signedIn === 'rejected' ? 'ADOPT_PASSWORD_REJECTED' : 'ENTRA_SIGN_IN_SURFACE_UNAVAILABLE',
      phase: signedIn === 'identity_challenge' ? 'identity_verification' : 'fresh_login_verification',
      retryable: signedIn === 'unavailable',
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: signedIn === 'identity_challenge'
        ? 'the adoption login needs interactive Entra identity approval before the staged candidate can be trusted'
        : signedIn === 'rejected'
          ? 'the Entra directory rejected the staged password candidate at sign-in'
          : 'the Entra password sign-in surface was unavailable',
    });
  }
  const identity = await assertEntraIdentity(session, contract, sink);
  if (!identity.ok) {
    return outcome(contract, {
      status: 'operation_failed',
      code: identity.code,
      phase: 'identity_verification',
      retryable: identity.retryable,
      providerEffect: 'none',
      rollbackStatus: 'none',
      reason: identity.reason,
    });
  }
  evidence.push('identity_verification:confirmed');
  const cookies = await session.ctx.cookies();
  await persistFreshCookieJar(account, cookies, { currentProxyUrl: proxyUrl });
  return outcome(contract, {
    status: 'operation_completed',
    providerEffect: 'none',
    rollbackStatus: 'none',
    changedAt: null,
    evidence,
    reason: 'the staged Entra password authenticated freshly against the asserted directory identity and can be adopted as managed',
  });
}
