// One-time interactive setup. Opens Chrome with the persistent profile and
// waits for you to sign in to Google manually (handle 2FA/passkey/phone).
// After this completes, every service-balance trajectory that uses
// launchRealChrome will inherit the Google session.
import { launchRealChrome } from './real_chrome.mjs';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

console.log('[setup] Opening Chrome. Sign in to Google with lukasz.bartoszcze@gmail.com.');
console.log('[setup] You may be prompted for 2FA / passkey / phone tap — complete it normally.');
console.log('[setup] When you land on myaccount.google.com or mail.google.com, this script will exit automatically.');

const s = await launchRealChrome({ label: 'setup_profile' });
try {
  await s.page.goto('https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/');
  const deadline = Date.now() + 10 * 60_000;
  const isDone = (u) => /myaccount\.google\.com|mail\.google\.com/.test(u);
  while (Date.now() < deadline) {
    if (isDone(s.page.url())) {
      console.log(`PASS: signed in (${s.page.url()}). Profile cookies persisted. Re-run service balance trajectories now.`);
      process.exit(0);
    }
    await humanIdlePause('short');
  }
  console.log('FAIL: 10-minute deadline reached without landing on myaccount/mail.google.com.');
  process.exit(1);
} finally {
  await s.close();
}
