// App Store review: rate and leave a review on an app via apps.apple.com.
// Requires signed-in Apple ID (via iCloud web session).
// Args: APP_ID (numeric), RATING (1-5), TITLE, REVIEW_TEXT.

import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';

const APP_ID = process.env.APP_ID;
const RATING = parseInt(process.env.RATING || '5', 10);
const TITLE = process.env.TITLE || 'Great app';
const REVIEW_TEXT = process.env.REVIEW_TEXT || 'Works as expected. Recommend it.';
if (!APP_ID) { console.log('FAIL: APP_ID env var required'); process.exit(1); }
if (RATING < 1 || RATING > 5) { console.log('FAIL: RATING must be 1-5'); process.exit(1); }

const acct = await getSocialAccount('apple');
if (!acct) { console.log('FAIL: no apple account'); process.exit(1); }

const s = await WSession.start({ label: 'apple_appstore_review', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(`https://apps.apple.com/us/app/id${APP_ID}`);
  await s.wait(5);
  // Click "Write a Review" — only shows if signed in and app is free to review
  await s.page.locator('button:has-text("Write a Review"), a:has-text("Write a Review")').first().click();
  await s.wait(4);

  // Sign-in iframe may appear
  if ((s.page.url?.() ?? '').includes('idmsa.apple.com')) {
    console.log('FAIL: need Apple ID sign-in for App Store reviews');
    process.exit(2);
  }

  // Star rating: click Nth star
  const stars = await s.page.locator('[role="radio"][aria-label*="star"], [class*="star"][role="button"]').all();
  if (stars[RATING - 1]) await stars[RATING - 1].click();
  await s.wait(1);

  // Fill title and body
  await s.page.locator('input[placeholder*="title" i], input[aria-label*="title" i]').fill(TITLE);
  await s.page.locator('textarea, [contenteditable="true"]').fill(REVIEW_TEXT);
  await s.wait(1);

  // Submit
  await s.page.locator('button:has-text("Send"), button:has-text("Submit")').click();
  await s.wait(5);

  console.log(`PASS: review submitted for app ${APP_ID} (${RATING}★)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
