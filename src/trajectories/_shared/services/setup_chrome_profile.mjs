// One-time interactive setup. Opens Chrome with the persistent profile and
// waits for you to sign in to Google manually (handle 2FA/passkey/phone).
// After this completes, every service-balance trajectory that uses
// launchRealChrome will inherit the Google session.
import { launchRealChrome } from '../../../browser/real_chrome.mjs';
import { urlMatching } from '../page/settled.mjs';

console.log('[setup] Opening Chrome. Sign in to the shared Google SSO account.');
console.log('[setup] You may be prompted for 2FA / passkey / phone tap — complete it normally.');
console.log('[setup] When you land on myaccount.google.com or mail.google.com, this script will exit automatically.');

const s = await launchRealChrome({ label: 'setup_profile' });
try {
  await s.page.goto('https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/');
  // Match the actual landed page HOST only. A regex over the whole URL
  // false-positives on the accounts.google.com sign-in page whose
  // `continue=` param contains "myaccount.google.com". The wait lasts until
  // the operator finishes signing in; closing the window ends it with an error.
  const landed = await urlMatching(s.page, /^https:\/\/(myaccount|mail)\.google\.com\//);
  console.log(`PASS: signed in (${landed}). Profile cookies persisted. Re-run service balance trajectories now.`);
} finally {
  await s.close();
}
