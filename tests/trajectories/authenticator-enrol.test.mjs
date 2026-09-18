// The setup key Google shows behind "Can't scan it?" is read out of the page
// text as one bare base32 secret, other text on the page is not mistaken for
// one, and every refusal the enrolment writes has the key redacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSetupKey, redactKeys } from '../../src/trajectories/_shared/services/google_sso/authenticator_enrol.mjs';

const GOOGLE_SETUP_DIALOG = [
  'Set up authenticator',
  'Enter this setup key in the authenticator app',
  'abcd efgh ijkl mnop qrst uvwx yz23 4567',
  'Next',
].join('\n');

test('the grouped setup key is read as one bare base32 secret', () => {
  assert.equal(extractSetupKey(GOOGLE_SETUP_DIALOG), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
});

test('a page without the eight groups yields no key', () => {
  assert.equal(extractSetupKey('Scan the QR code with your authenticator app\nCan\'t scan it?'), '');
  assert.equal(extractSetupKey('abcd efgh ijkl mnop'), '');
});

test('a refusal preview never carries the key', () => {
  const preview = redactKeys(GOOGLE_SETUP_DIALOG);
  assert.equal(preview.includes('abcd efgh'), false);
  assert.equal(preview.includes('<redacted-setup-key>'), true);
});
