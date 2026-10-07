import { pageCondition, pageSettled } from '../../_shared/page/settled.mjs';
// Google Play Console: publish an Android app release — fully browser-driven.
//
// Drives play.google.com/console exactly as a human would: open the app's
// chosen track -> "Create new release" -> upload the AAB/APK via the file
// input -> fill release notes -> Next/Save -> "Review release" -> terminal
// "Start rollout" / "Send for review" -> confirm. Verifies a success/rollout
// status before reporting PASS.
//
// Unlike App Store Connect, Play Console DOES expose a web upload form for the
// app bundle, so this trajectory performs the binary upload too.
//
// Args (env):
//   BUNDLE_PATH      (required) local path to the .aab (or .apk) to upload
//   PACKAGE_NAME     (required unless PLAY_RELEASE_URL given) e.g. com.foo.bar
//   PLAY_RELEASE_URL (optional) full Play Console URL of the track's release
//                    page; when set, navigation by package is skipped
//   TRACK            (optional) internal | closed | open | production
//                    (default internal)
//   RELEASE_NAME     (optional) release name shown in the console
//   RELEASE_NOTES    (optional) "What's new" notes for the default language
//   SUBMIT           (optional) "0" stages the release but stops before the
//                    terminal rollout/send-for-review click. Otherwise sends.
//   PROXY_URL        (optional) override proxy
//
// Requires a logged-in Google session for an account with Play Console access
// (run a google login/register trajectory first to seed the cookie jar).

import { existsSync } from 'node:fs';
import { getSocialAccount } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';

const BUNDLE_PATH = process.env.BUNDLE_PATH;
const PACKAGE_NAME = process.env.PACKAGE_NAME;
const PLAY_RELEASE_URL = process.env.PLAY_RELEASE_URL;
const TRACK = (process.env.TRACK || 'internal').toLowerCase();
const RELEASE_NAME = process.env.RELEASE_NAME;
const RELEASE_NOTES = process.env.RELEASE_NOTES;
const SUBMIT = process.env.SUBMIT !== '0';

if (!BUNDLE_PATH || !existsSync(BUNDLE_PATH)) { console.log(`FAIL: BUNDLE_PATH env var must point to an existing .aab/.apk (got: ${BUNDLE_PATH || 'unset'})`); process.exit(1); }
if (!PACKAGE_NAME && !PLAY_RELEASE_URL) { console.log('FAIL: PACKAGE_NAME or PLAY_RELEASE_URL env var required'); process.exit(1); }

const trackNav = { internal: 'Internal testing', closed: 'Closed testing', open: 'Open testing', production: 'Production' };
const navLabel = trackNav[TRACK];
if (!navLabel) { console.log(`FAIL: TRACK must be one of internal|closed|open|production (got: ${TRACK})`); process.exit(1); }

const acct = await getSocialAccount('google');
if (!acct) { console.log('FAIL: no google account'); process.exit(1); }

// Click the first visible match among several selector variants for ONE
// control (Play Console markup shifts between revisions) once the page has
// settled. These are alternate selectors for the same button, not a provider
// rollover; false means the settled page shows none of them.
async function clickAny(s, selectors, label) {
  await pageSettled(s.page);
  for (const sel of selectors) {
    const loc = s.page.locator(sel).first();
    if (await loc.isVisible()) {
      await humanClickLocator(s.page, loc);
      if (label) console.log(`[play-submit] clicked: ${label}`);
      return true;
    }
  }
  return false;
}

// Fill the first visible match among selector variants. Returns true if filled.
async function fillAny(s, selectors, value, label) {
  for (const sel of selectors) {
    const loc = s.page.locator(sel).first();
    if (await loc.isVisible()) {
      await humanFill(s.page, loc, value);
      if (label) console.log(`[play-submit] filled: ${label}`);
      return true;
    }
  }
  return false;
}

async function runRelease() {
  const s = await WSession.start({ label: 'google_play_submit', proxy: process.env.PROXY_URL || undefined });
  try {
    // 1) Reach the track's release page.
    if (PLAY_RELEASE_URL) {
      await s.goto(PLAY_RELEASE_URL);
    } else {
      await s.goto('https://play.google.com/console/u/0/developers');
    }
    await pageSettled(s.page);
    if ((s.page.url?.() ?? '').includes('accounts.google.com')) {
      console.log('FAIL: session expired / not logged in, run a google login trajectory first');
      return 2;
    }

    // Navigate by package when no direct URL was given: open the app, then the
    // track in the left nav.
    if (!PLAY_RELEASE_URL) {
      const appLink = s.page.locator(`a:has-text("${PACKAGE_NAME}"), tr:has-text("${PACKAGE_NAME}") a, [aria-label*="${PACKAGE_NAME}"]`).first();
      if (await appLink.isVisible()) {
        await humanClickLocator(s.page, appLink);
        await pageSettled(s.page);
      } else {
        console.log(`FAIL: app "${PACKAGE_NAME}" not found in the Play Console app list`);
        return 1;
      }
      const navOpened = await clickAny(s, [`a:has-text("${navLabel}")`, `span:has-text("${navLabel}")`, `[aria-label="${navLabel}"]`], `${navLabel} nav`);
      if (!navOpened) {
        throw new Error(`PLAY_RELEASE_TRACK_UNAVAILABLE: no ${navLabel} navigation control at ${s.page.url()}`);
      }
      await pageSettled(s.page);
    }

    // 2) Create a new release.
    const created = await clickAny(s, [
      'button:has-text("Create new release")',
      'button:has-text("Create release")',
      'a:has-text("Create new release")',
    ], 'Create new release');
    if (!created) {
      console.log('FAIL: "Create new release" control not found on track page');
      return 1;
    }
    await pageSettled(s.page);

    // 3) Upload the bundle through the file input. setInputFiles is the only
    //    mechanism for a file picker and emits a genuine change event.
    const fileInput = s.page.locator('input[type="file"]').first();
    await fileInput.waitFor({ state: 'attached' });
    await fileInput.setInputFiles(BUNDLE_PATH);
    console.log(`[play-submit] uploading ${BUNDLE_PATH}`);

    // The bundle is processed once the file input is no longer busy and the
    // release's artifact table has a row; Play Console marks an upload failure
    // with an alert in the upload region. The condition reads those, not words.
    const upload = await pageCondition(s.page, () => {
      const alert = document.querySelector('[role="alert"], [role="alertdialog"]');
      if (alert && alert.offsetParent !== null) return 'error';
      const uploading = document.querySelector('[role="progressbar"]');
      if (uploading && uploading.offsetParent !== null) return false;
      const artifacts = document.querySelector('table tbody tr, [role="table"] [role="row"] + [role="row"]');
      return artifacts ? 'done' : false;
    });
    if (upload === 'error') {
      const alert = await s.page.locator('[role="alert"], [role="alertdialog"]').first().innerText();
      console.log(`FAIL: Play Console reported an upload error: ${alert}`);
      return 3;
    }
    console.log('[play-submit] bundle processed');

    // 4) Release name + notes (optional).
    if (RELEASE_NAME) {
      const named = await fillAny(s, ['input[aria-label*="Release name" i]', 'input[id*="release-name" i]', 'input[name*="releaseName" i]'], RELEASE_NAME, 'release name');
      if (!named) throw new Error('PLAY_RELEASE_NAME_UNAVAILABLE: no visible release-name input');
      await pageSettled(s.page);
    }
    if (RELEASE_NOTES) {
      const notesOk = await fillAny(s, ['textarea[aria-label*="release notes" i]', 'textarea[id*="release-notes" i]', 'textarea[placeholder*="What" i]', 'textarea'], RELEASE_NOTES, 'release notes');
      if (!notesOk) throw new Error('PLAY_RELEASE_NOTES_UNAVAILABLE: no visible release-notes input');
      await pageSettled(s.page);
    }

    // 5) Advance: Next / Save.
    const advanced = await clickAny(s, ['button:has-text("Next")', 'button:has-text("Save")'], 'Next/Save');
    if (!advanced) throw new Error('PLAY_RELEASE_ADVANCE_UNAVAILABLE: no visible Next or Save control');
    await pageSettled(s.page);

    if (!SUBMIT) {
      console.log(`PASS: staged ${TRACK} release for ${PACKAGE_NAME || PLAY_RELEASE_URL} (SUBMIT=0, not sent)`);
      return 0;
    }

    // 6) Review screen then terminal rollout / send-for-review (+ confirm dialog).
    await clickAny(s, ['button:has-text("Review release")', 'button:has-text("Review")'], 'Review release');
    await pageSettled(s.page);

    const sent = await clickAny(s, [
      `button:has-text("Start rollout to ${navLabel}")`,
      'button:has-text("Start rollout")',
      'button:has-text("Send for review")',
      'button:has-text("Send change for review")',
      'button:has-text("Rollout")',
    ], 'Start rollout / Send for review');
    if (!sent) {
      let labels = [];
      try {
        labels = await s.page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).filter((t) => t.length));
      } catch (e) { console.log('[play-submit] button probe failed:', e.message); }
      console.log('[play-submit] buttons on page:', JSON.stringify(labels));
      console.log('FAIL: terminal rollout/send-for-review button not found');
      return 1;
    }
    await pageSettled(s.page);
    // Confirmation dialog.
    await clickAny(s, ['button:has-text("Rollout")', 'button:has-text("Send for review")', 'button:has-text("Confirm")'], 'confirm rollout');
    await pageSettled(s.page);

    // 7) Verify a sent/rollout status surfaced.
    const status = await s.page.evaluate(() => {
      const m = (document.body?.innerText || '').match(/In review|Sent for review|Rolling out|Live|Available to|Published|Full rollout/i);
      return m ? m[0] : '';
    });
    if (status) {
      console.log(`PASS: ${TRACK} release sent for ${PACKAGE_NAME || PLAY_RELEASE_URL} — status "${status}"`);
      return 0;
    }
    throw new Error(`PLAY_RELEASE_OUTCOME_UNOBSERVED: no release status observed at ${s.page.url()}`);
  } catch (e) {
    console.log('FAIL:', e.message);
    return 1;
  } finally {
    await s.close();
  }
}

process.exitCode = await runRelease();
