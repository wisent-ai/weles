import { test } from 'node:test';
import * as assert from 'node:assert';

import {
  classify,
} from '../../dist/agent/browser-evidence-policy/interactive-control/admission.js';

// What a browser-evidence run refuses to touch, driven through the shipped
// classifier.
//
// The ten families are declared in
// `src/agent/browser-evidence-policy/interactive-control/withheld-categories.json`
// with the reason each exists and the reason the order is what it is. Nothing
// exercised the policy before: a family lost in an edit, or two swapped, and
// an evidence run would press a payment or a deletion button and nobody would
// find out until it had.

const NO_CONTROL = null;
const PAGE = 'https://example.com/account';

test('every declared family is recognised from the wording on the control', () => {
  const cases: Array<[string, string]> = [
    ['Allow notifications', 'notification_control'],
    ['Allow camera access', 'browser_permission_control'],
    ['Download invoice', 'system_ui_download'],
    ['Enter your verification code', 'mfa_2fa'],
    ['Remember this device', 'trusted_device'],
    ['Forgot your password?', 'account_recovery_submission'],
    ['Sign in with Google', 'authentication_submission'],
    ['Upgrade plan', 'purchase_subscription_payment'],
    ['Delete workspace', 'destructive_confirmation'],
    ['Publish reply', 'messaging_submission'],
  ];
  for (const [wording, expected] of cases) {
    const verdict = classify(wording, NO_CONTROL, PAGE);
    assert.equal(verdict?.category, expected, `"${wording}" was classified ${verdict?.category}`);
    assert.ok((verdict?.reason ?? '').length > 0, `${expected} carries no reason`);
  }
});

test('a recovery link on a sign-in page is recovery, not a sign-in', () => {
  const verdict = classify('Forgot password? Sign in instead', NO_CONTROL, PAGE);
  assert.equal(verdict?.category, 'account_recovery_submission');
});

test('a form carrying a password is a sign-in whatever its button says', () => {
  const control = {
    label: 'Continue',
    formPresent: true,
    formHasPassword: true,
  } as never;
  const verdict = classify('Continue', control, PAGE);
  assert.equal(verdict?.category, 'authentication_submission');
});

test('a form that can send a message is withheld even with a bland label', () => {
  const control = {
    label: 'Continue',
    formPresent: true,
    formHasMessage: true,
  } as never;
  assert.equal(classify('Continue', control, PAGE)?.category, 'messaging_submission');
});

test('ordinary reading is not withheld', () => {
  assert.equal(classify('Pricing', NO_CONTROL, 'https://example.com/pricing'), null);
  assert.equal(classify('Next page', NO_CONTROL, PAGE), null);
});
