// The worker's dispatch for the two actions that sign one Skarbiec Google
// login into its own account settings — google_authenticator_enrol and
// google_app_password — through the compiled worker: each action resolves to
// its trajectory for google only, a login_item is admitted as
// WELES_LOGIN_ITEM, and a request without one is refused by name.
//
// The route that orders the enrolment, `POST /reauth/enrol-authenticator`, is
// admitted by Brama's reauth bearer rather than the general worker token,
// because the product that reports `google_2fa_material_missing` is the one
// that has to order its repair. That route is exercised against a deployed
// worker, not here: its module reads the release identity a checkout does not
// carry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrajectory } from '../../dist/worker/dispatch.js';
import { paramsToEnv } from '../../dist/worker/params/params-to-env.js';

const ACTIONS = [
  { action: 'google_authenticator_enrol', other: 'apple_authenticator_enrol', trajectory: 'src/trajectories/google/authenticator/enrol.mjs' },
  { action: 'google_app_password', other: 'microsoft_app_password', trajectory: 'src/trajectories/google/app_password/create.mjs' },
];

for (const { action, other, trajectory } of ACTIONS) {
  test(`${action} resolves to its trajectory for google only`, () => {
    assert.equal(resolveTrajectory(action), trajectory);
    assert.equal(resolveTrajectory(other), null);
  });

  test(`${action} admits a login_item as the login the trajectory signs in`, () => {
    const env = paramsToEnv({ login_item: 'codex-wisent-google-sso' }, action, trajectory);
    assert.equal(env.WELES_LOGIN_ITEM, 'codex-wisent-google-sso');
  });

  test(`${action} refuses a request without a login_item by name`, () => {
    assert.throws(
      () => paramsToEnv({}, action, trajectory),
      /login_item must name the exact Skarbiec Google login item this action signs in/,
    );
  });
}
