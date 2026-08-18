// App Store review (web): rate and leave a review on an app via apps.apple.com.
// Requires signed-in Apple ID — rerun apple/login.mjs (or seed cookies via
// cross_login) if the trajectory lands on idmsa.apple.com.
// Args: APP_ID (numeric), RATING (1-5), TITLE, REVIEW_TEXT.

import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClick, humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const APP_ID = process.env.APP_ID;
const RATING = parseInt(process.env.RATING || '5', 10);
const TITLE = process.env.TITLE || 'Great app';
const REVIEW_TEXT = process.env.REVIEW_TEXT || 'Works as expected. Recommend it.';
if (!APP_ID) { console.log('FAIL: APP_ID env var required'); process.exit(1); }
if (!/^\d+$/.test(APP_ID)) { console.log('FAIL: APP_ID must be numeric'); process.exit(1); }
if (RATING < 1 || RATING > 5) { console.log('FAIL: RATING must be 1-5'); process.exit(1); }

const acct = await getSocialAccount('apple');
if (!acct) { console.log('FAIL: no apple account'); process.exit(1); }

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({
  label: 'apple_appstore_review',
  proxy: proxyUrl ?? (process.env.PROXY_URL || undefined),
  persona,
});
try {
  await s.goto(`https://apps.apple.com/us/app/id${APP_ID}`);
  await s.wait(5);

  // Apple bounced us to login before the listing rendered → cookies stale.
  // Routine should skip this account for 24h instead of re-trying.
  const initialUrl = s.page.url?.() ?? '';
  if (initialUrl.includes('idmsa.apple.com') || initialUrl.includes('/login')) {
    console.log('FAIL_COOKIES_STALE: redirected to Apple ID login on listing fetch');
    process.exit(2);
  }

  // Ratings & Reviews section lives further down the listing. A few wheel
  // bursts with short idle dwells bring it into view at human cadence.
  for (let i = 0; i < 3; i++) {
    await s.page.mouse.wheel(0, 600);
    await humanIdlePause('short');
  }
  await humanIdlePause('deliberate');

  // humanClickLocator throws if the element is absent; the outer catch
  // turns that into a generic FAIL. That is the right behaviour for
  // "Write a Review absent" — usually means not signed in.
  await humanClickLocator(s.page, s.page.locator('button:has-text("Write a Review"), a:has-text("Write a Review")').first());
  await s.wait(4);

  // The review modal can redirect to idmsa for re-auth when cookies are stale.
  const postClickUrl = s.page.url?.() ?? '';
  if (postClickUrl.includes('idmsa.apple.com')) {
    console.log('FAIL_COOKIES_STALE: modal redirected to Apple ID sign-in');
    process.exit(2);
  }

  // Star rating. Apple renders 5 radios labelled "<n> stars". Resolve the
  // Nth radio's bbox and humanClick its centre; the keyboard-driven widget
  // is unreliable under locator.click pointer events historically.
  const starLocator = s.page.locator(`[role="radio"][aria-label*="${RATING} star"], [role="radio"][aria-label="${RATING}"]`).first();
  const box = await starLocator.boundingBox();
  if (!box) { console.log(`FAIL: rating radio has no bounding box for RATING=${RATING}`); process.exit(1); }
  await humanClick(s.page, Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  await humanIdlePause('deliberate');

  // Title field.
  await humanFill(s.page, s.page.locator('input[placeholder*="title" i], input[aria-label*="title" i]').first(), TITLE);
  await humanIdlePause('deliberate');

  // Review body — textarea or contenteditable.
  await humanFill(s.page, s.page.locator('textarea, [contenteditable="true"]').first(), REVIEW_TEXT);
  await humanIdlePause('deliberate');

  // Submit. Apple labels the button "Send" in the public web review modal.
  await humanClickLocator(s.page, s.page.locator('button:has-text("Send"), button:has-text("Submit")').first());
  await s.wait(6);

  // Verify: Apple does not redirect on submit; the modal collapses back to
  // the listing. If we ended up at idmsa, cookies were invalidated mid-submit.
  const finalUrl = s.page.url?.() ?? '';
  if (finalUrl.includes('idmsa.apple.com')) {
    console.log('FAIL_COOKIES_STALE: submit redirected to Apple ID sign-in');
    process.exit(2);
  }

  console.log(`PASS: review submitted for app ${APP_ID} (${RATING}★)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
