// The repair for the one refusal a sign-in cannot repair itself.
//
// `google_2fa_material_missing` means the login Weles holds carries no
// authenticator seed, and no sign-in can invent one: Google shows a setup key
// only inside a signed-in session. The enrolment trajectory does exactly that
// once -- one approval on the operator's phone, then it reads the key, proves
// the first code, and writes it to the login item -- and every later sign-in
// for that account answers Google by itself. The route is admitted by Brama's
// reauth token, like /reauth, so the product that reports the refusal can
// order its own repair.
import { constants as http } from 'node:http2';
import { json } from '../../http-exchange.mjs';
import { admittedReauthAccount } from './reauth-account.mjs';
import { answerRefusal } from './refusal.mjs';

/// The dispatch name of the trajectory that enrols a Google Authenticator for
/// one Skarbiec login and writes the seed back to it.
const AUTHENTICATOR_ENROL_ACTION = 'google_authenticator_enrol';
const authenticatorEnrolments = new Map();

/** Whether the run's own result confirms the seed was written to exactly this login. */
function confirmedEnrolment(out, account) {
  const result = out.result;
  return (
    out.ok === true &&
    Boolean(result) &&
    result.ok === true &&
    result.login_item === account.loginItem &&
    typeof result.email === 'string' &&
    result.email.trim().toLowerCase() ===
      account.accountRef.trim().toLowerCase() &&
    result.seed_written === true
  );
}

/** What blocked an enrolment that was not confirmed, as the run stated it or as its absence. */
function enrolmentBlock(out, confirmed) {
  if (confirmed) return { blocked: null, message: null };
  const result = out.result && typeof out.result === 'object' ? out.result : {};
  return {
    blocked:
      typeof result.blocked === 'string'
        ? result.blocked
        : 'authenticator_enrolment_unconfirmed',
    message:
      typeof result.detail === 'string'
        ? result.detail
        : typeof result.error === 'string'
          ? result.error
          : `the enrolment run ended ${out.ok ? 'without confirming the seed was written to this login' : 'in failure'}`,
  };
}

export async function respondToAuthenticatorEnrolment(
  req,
  res,
  selectLoginAccount,
  runTrajectory,
) {
  let admitted;
  try {
    admitted = await admittedReauthAccount(
      req,
      selectLoginAccount,
      'authenticator enrolment',
    );
  } catch (error) {
    answerRefusal(res, error);
    return;
  }
  const { account, identity } = admitted;
  // The login method and the one live enrolment per Google account are the
  // action's own refusals, the same for every caller. Here only a live
  // enrolment of the same login is joined, so this route's concurrent callers
  // share one run; a completed refusal is not cached and cannot hide a repair.
  const key = account.accountRef.toLowerCase();
  const live = authenticatorEnrolments.get(key);
  const joined = Boolean(live) && live.loginItem === account.loginItem;
  const run = () =>
    runTrajectory(
      AUTHENTICATOR_ENROL_ACTION,
      { login_item: account.loginItem, expected_account: account.accountRef },
      null,
      false,
    );
  let promise;
  if (joined) {
    promise = live.promise;
  } else if (live) {
    // Another login of this account is enrolling: the action answers that
    // with its own `authenticator_enrolment_in_progress`.
    promise = Promise.resolve().then(run);
  } else {
    promise = Promise.resolve()
      .then(run)
      .finally(() => {
        authenticatorEnrolments.delete(key);
      });
    authenticatorEnrolments.set(key, { loginItem: account.loginItem, promise });
  }
  const out = await promise;
  const confirmed = confirmedEnrolment(out, account);
  json(res, confirmed ? http.HTTP_STATUS_OK : http.HTTP_STATUS_BAD_GATEWAY, {
    ...out,
    ...identity,
    ok: confirmed,
    coalesced: joined,
    ...enrolmentBlock(out, confirmed),
  });
}
