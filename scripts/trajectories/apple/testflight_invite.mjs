// TestFlight: invite a tester by email to a given app/group.
// Args: APP_ID (numeric), TESTER_EMAIL, GROUP_NAME (optional, defaults to first group).

import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

const APP_ID = process.env.APP_ID;
const TESTER_EMAIL = process.env.TESTER_EMAIL;
const GROUP_NAME = process.env.GROUP_NAME;
if (!APP_ID || !TESTER_EMAIL) { console.log('FAIL: APP_ID and TESTER_EMAIL env vars required'); process.exit(1); }

const acct = await getSocialAccount('apple');
if (!acct) { console.log('FAIL: no apple account'); process.exit(1); }

const s = await WSession.start({ label: 'apple_testflight_invite', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(`https://appstoreconnect.apple.com/apps/${APP_ID}/testflight/groups`);
  await s.wait(8);
  if ((s.page.url?.() ?? '').includes('idmsa.apple.com')) {
    console.log('FAIL: session expired, rerun apple/login.mjs');
    process.exit(2);
  }

  // Click into group (first one if no name specified)
  if (GROUP_NAME) {
    await humanClickLocator(s.page, s.page.locator(`a:has-text("${GROUP_NAME}")`).first());
  } else {
    await humanClickLocator(s.page, s.page.locator('a[href*="/testflight/groups/"]').first());
  }
  await s.wait(4);

  // Go to Testers tab
  await humanClickLocator(s.page, s.page.locator('a:has-text("Testers"), button:has-text("Testers")').first()).catch(() => {});
  await s.wait(3);

  // Click + to add
  await humanClickLocator(s.page, s.page.locator('button:has-text("Add"), button[aria-label*="Add"]').first());
  await s.wait(2);

  // Add by email
  await humanClickLocator(s.page, s.page.locator('button:has-text("Email"), label:has-text("Email")').first()).catch(() => {});
  await s.wait(2);
  await s.page.locator('input[type="email"], input[placeholder*="email" i]').fill(TESTER_EMAIL);
  await s.wait(1);
  await s.page.locator('button:has-text("Add"), button:has-text("Invite")').last().click();
  await s.wait(5);

  console.log(`PASS: invited ${TESTER_EMAIL} to app ${APP_ID}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
