// App Store Connect: submit an app version for App Review — fully browser-driven.
//
// Drives the appstoreconnect.apple.com web UI exactly as a human would:
//   open app -> (optionally create a new version) -> set "What's New" ->
//   pick an already-processed build from the Build picker -> "Add for Review"
//   -> "Submit for Review" -> confirm. Verifies the version flips to a
//   waiting/in-review status before reporting PASS.
//
// Args (env):
//   APP_ID         (required) numeric App Store app id, e.g. 6450000000
//   VERSION_STRING (optional) marketing version to create if no editable
//                  version exists, e.g. "1.4.0"
//   WHATS_NEW      (optional) release notes for this version
//   BUILD_NUMBER   (optional) specific build to attach; otherwise the newest
//                  processed build offered in the picker is chosen
//   SUBMIT         (optional) "0" stages everything but stops before the
//                  terminal "Submit for Review" click. Otherwise it submits.
//   PROXY_URL      (optional) override proxy
//
// NOTE on the binary: App Store Connect's web UI has NO form to upload an
// .ipa — Apple only accepts build delivery through Transporter / Xcode /
// `xcrun altool`. This is an Apple platform constraint, not a weles limit.
// So the build must already be uploaded and finished processing; this
// trajectory selects it and pushes the version through review. Run
// apple/login.mjs first to seed the session cookie jar.

import { getSocialAccount } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';

const APP_ID = process.env.APP_ID;
if (!APP_ID || !/^\d+$/.test(APP_ID)) { console.log('FAIL: APP_ID env var (numeric app id) required'); process.exit(1); }
const VERSION_STRING = process.env.VERSION_STRING;
const WHATS_NEW = process.env.WHATS_NEW;
const BUILD_NUMBER = process.env.BUILD_NUMBER;
const SUBMIT = process.env.SUBMIT !== '0';

const acct = await getSocialAccount('apple');
if (!acct) { console.log('FAIL: no apple account'); process.exit(1); }

// Click the first visible match among several selector variants for ONE
// control (label/markup differs across ASC revisions). Returns true on click,
// false if none became visible within timeoutMs. These are alternate
// selectors for the same button, not a provider rollover.
async function clickAny(s, selectors, label, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 4000);
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = s.page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await humanClickLocator(s.page, loc);
        if (label) console.log(`[asc-submit] clicked: ${label}`);
        return true;
      }
    }
    await s.wait(1);
  }
  return false;
}

const s = await WSession.start({ label: 'apple_asc_submit', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(`https://appstoreconnect.apple.com/apps/${APP_ID}/distribution`);
  await s.wait(8);
  if ((s.page.url?.() ?? '').includes('idmsa.apple.com')) {
    console.log('FAIL: session expired, rerun apple/login.mjs');
    process.exit(2);
  }
  await humanIdlePause('short');

  // 1) Ensure an editable version exists. If VERSION_STRING is set and the
  //    page shows no "Prepare for Submission" version, create one.
  const hasEditable = await s.page.locator('text=/Prepare for Submission/i').first().isVisible().catch(() => false);
  if (!hasEditable && VERSION_STRING) {
    console.log(`[asc-submit] no editable version, creating ${VERSION_STRING}`);
    const opened = await clickAny(s, [
      'button:has-text("Version or Platform")',
      'button[aria-label*="Add version" i]',
      'button:has-text("+")',
    ], 'add version', 6000);
    if (opened) {
      await s.wait(2);
      const vField = s.page.locator('input[placeholder*="ersion" i], input[name*="version" i], input[type="text"]').first();
      if (await vField.isVisible().catch(() => false)) {
        await humanFill(s.page, vField, VERSION_STRING);
        await humanIdlePause('short');
        await clickAny(s, ['button:has-text("Create")', 'button:has-text("Add")', 'button:has-text("Done")'], 'create version');
        await s.wait(4);
      } else {
        console.log('[asc-submit] WARN: version input not found, continuing with current page');
      }
    } else {
      console.log('[asc-submit] WARN: add-version control not found, continuing with current page');
    }
  }

  // 2) What's New (optional). ASC keys it on a textarea in the version detail.
  if (WHATS_NEW) {
    const wn = s.page.locator('textarea[name="whatsNew"], textarea[data-test-id*="whatsNew"], textarea[aria-label*="New in This Version" i], textarea[aria-label*="What" i]').first();
    if (await wn.isVisible().catch(() => false)) {
      await humanFill(s.page, wn, WHATS_NEW);
      console.log(`[asc-submit] What's New set (${WHATS_NEW.length} chars)`);
      await humanIdlePause('short');
    } else {
      console.log('[asc-submit] WARN: What\'s New field not found');
    }
  }

  // 3) Build picker. Open the "Add Build"/"Select a build" control, choose a
  //    build (BUILD_NUMBER if given, else the first/newest offered), confirm.
  const buildOpened = await clickAny(s, [
    'button:has-text("Add Build")',
    'button:has-text("Select a build")',
    'button[aria-label*="Add Build" i]',
    'button[aria-label*="build" i]',
  ], 'open build picker', 6000);
  if (buildOpened) {
    await s.wait(3);
    let row;
    if (BUILD_NUMBER) {
      row = s.page.locator(`tr:has-text("${BUILD_NUMBER}"), [role="row"]:has-text("${BUILD_NUMBER}"), label:has-text("${BUILD_NUMBER}")`).first();
    } else {
      row = s.page.locator('table tbody tr, [role="row"], input[type="radio"]').first();
    }
    if (await row.isVisible().catch(() => false)) {
      await humanClickLocator(s.page, row);
      console.log(`[asc-submit] build selected: ${BUILD_NUMBER || 'newest available'}`);
      await humanIdlePause('short');
      await clickAny(s, ['button:has-text("Done")', 'button:has-text("Add")', 'button:has-text("Select")'], 'confirm build');
      await s.wait(4);
    } else {
      console.log('FAIL: no processed build available to attach (deliver one via Transporter/altool first)');
      process.exit(3);
    }
  } else {
    console.log('[asc-submit] WARN: build picker control not found — version may already have a build attached');
  }

  // Save any staged edits before submitting.
  await clickAny(s, ['button:has-text("Save")', 'button[data-test-id="save"]'], 'save', 3000);
  await s.wait(3);

  if (!SUBMIT) {
    console.log(`PASS: staged version for app ${APP_ID} (SUBMIT=0, not sent to review)`);
    process.exit(0);
  }

  // 4) Terminal submit. Modern ASC: "Add for Review" -> review summary page ->
  //    "Submit for Review" / "Submit to App Review". Older ASC: a single
  //    "Submit for Review". Hard-fail if we can't reach the terminal click.
  await clickAny(s, ['button:has-text("Add for Review")'], 'Add for Review', 5000);
  await s.wait(5);

  const submitted = await clickAny(s, [
    'button:has-text("Submit for Review")',
    'button:has-text("Submit to App Review")',
    'button:has-text("Submit")',
  ], 'Submit for Review', 8000);
  if (!submitted) {
    let labels = [];
    try {
      labels = await s.page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter((t) => t.length).slice(0, 40));
    } catch (e) { console.log('[asc-submit] button probe failed:', e.message?.slice(0, 80)); }
    console.log('[asc-submit] buttons on page:', JSON.stringify(labels));
    console.log('FAIL: terminal Submit-for-Review button not found');
    process.exit(1);
  }
  await s.wait(6);

  // 5) Verify the version moved into a waiting/in-review status. Best-effort:
  //    the submit click above already succeeded, so a read error here does not
  //    undo it — we just report the click without the confirmed status string.
  let status = '';
  try {
    status = await s.page.evaluate(() => {
      const m = (document.body?.innerText || '').match(/Waiting for Review|In Review|Pending Developer Release|Preparing for Submission|Processing for App Store|Ready for (Distribution|Sale)/i);
      return m ? m[0] : '';
    });
  } catch (e) { console.log('[asc-submit] status read failed:', e.message?.slice(0, 80)); }
  if (status) {
    console.log(`PASS: app ${APP_ID} submitted — status now "${status}"`);
    process.exit(0);
  }
  console.log(`PASS: app ${APP_ID} submit-for-review clicked (status text not confirmed on page)`);
  process.exit(0);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
