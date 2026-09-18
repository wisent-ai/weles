// The worker's dispatch for google_authenticator_enrol, through the compiled
// worker: the action resolves to the enrolment trajectory, a login_item is
// admitted as WELES_LOGIN_ITEM, and a request without one is refused by name.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTrajectory } from '../../dist/worker/dispatch.js';
import { paramsToEnv } from '../../dist/worker/params/params-to-env.js';

const ACTION = 'google_authenticator_enrol';
const TRAJECTORY = 'src/trajectories/google/authenticator/enrol.mjs';

test('the action resolves to the enrolment trajectory for google only', () => {
  assert.equal(resolveTrajectory(ACTION), TRAJECTORY);
  assert.equal(resolveTrajectory('apple_authenticator_enrol'), null);
});

test('a login_item is admitted as the login item the trajectory enrols', () => {
  const env = paramsToEnv({ login_item: 'claude-wisent-google-sso' }, ACTION, TRAJECTORY);
  assert.equal(env.WELES_LOGIN_ITEM, 'claude-wisent-google-sso');
});

test('a request without a login_item is refused by name', () => {
  assert.throws(
    () => paramsToEnv({}, ACTION, TRAJECTORY),
    /login_item must name the exact Skarbiec login item to enrol an authenticator for/,
  );
});
