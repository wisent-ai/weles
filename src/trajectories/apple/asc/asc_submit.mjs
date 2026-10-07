import { pageSettled } from '../../_shared/page/settled.mjs';
// App Store Connect: upload a build AND submit it for App Review — fully
// automated, no human/Transporter step.
//
// When IPA_PATH is set, the .ipa is delivered headlessly via `xcrun altool`
// (see altool_upload.mjs), then the trajectory drives the appstoreconnect.apple.com
// web UI: open app -> (optionally create a version) -> set "What's New" ->
// poll until the just-uploaded build finishes processing and is selectable ->
// pick it -> "Add for Review" -> "Submit for Review" -> verify status.
//
// APP_ID is required; IPA_PATH optionally enables binary upload. Upload
// credentials come only from the exact Weles App Store Connect API item.
//   VERSION_STRING (optional) marketing version to create if none is editable
//   WHATS_NEW      (optional) release notes for this version
//   BUILD_NUMBER   (optional) specific build to attach; else newest selectable
//   SUBMIT         (optional) "0" stages everything but stops before submit
//   PROXY_URL      (optional) override proxy
//
// Run apple/login.mjs first to seed the session cookie jar.

import { getSocialAccount } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { uploadIpa } from './altool_upload.mjs';
import { readScopedSecret } from '../../../_shared/scoped-secrets.mjs';

const APP_ID = process.env.APP_ID;
if (!APP_ID || !/^\d+$/.test(APP_ID)) {
  console.log('FAIL: APP_ID env var (numeric app id) required');
  process.exit(1);
}
const IPA_PATH = process.env.IPA_PATH;
const VERSION_STRING = process.env.VERSION_STRING;
const WHATS_NEW = process.env.WHATS_NEW;
const BUILD_NUMBER = process.env.BUILD_NUMBER;
const SUBMIT = process.env.SUBMIT !== '0';
const DIST_URL = `https://appstoreconnect.apple.com/apps/${APP_ID}/distribution`;

const acct = await getSocialAccount('apple');
if (!acct) {
  console.log('FAIL: no apple account');
  process.exit(1);
}

// Step 0: headless binary delivery. altool validates the .ipa at upload, so a
// failure here surfaces immediately and the browser phase never starts.
if (IPA_PATH) {
  await uploadIpa({
    ipaPath: IPA_PATH,
    keyId: readScopedSecret('appleAppStoreConnectApi', 'key_id'),
    issuerId: readScopedSecret('appleAppStoreConnectApi', 'issuer_id'),
    privateKey: readScopedSecret('appleAppStoreConnectApi', 'private_key'),
    platform: process.env.APPLE_PLATFORM || 'ios',
  });
}

// Click the first visible match among several selector variants for ONE
// control (label/markup differs across ASC revisions) once the page has
// settled. Returns true on click, false when the settled page shows none.
// Alternate selectors for the same button, not a provider rollover.
async function clickAny(s, selectors, label) {
  await pageSettled(s.page);
  for (const sel of selectors) {
    const loc = s.page.locator(sel).first();
    if (await loc.isVisible()) {
      if (!(await loc.isEnabled())) {
        throw Object.assign(
          new Error(`App Store Connect control is disabled: ${label || sel}`),
          {
            code: 'ASC_CONTROL_DISABLED',
            selector: sel,
            control: label ?? null,
            pageUrl: s.page.url(),
          },
        );
      }
      await humanClickLocator(s.page, loc);
      if (label) console.log(`[asc-submit] clicked: ${label}`);
      return true;
    }
  }
  return false;
}

async function fillObserved(page, field, value, label) {
  if (!(await field.isEditable())) {
    throw Object.assign(
      new Error(`App Store Connect ${label} field is not editable`),
      {
        code: 'ASC_FIELD_NOT_EDITABLE',
        field: label,
        pageUrl: page.url(),
      },
    );
  }
  await humanFill(page, field, value);
  await page.keyboard.press('Tab');
  const observed = await field.inputValue();
  if (observed !== value) {
    throw Object.assign(
      new Error(
        `App Store Connect ${label} input differs from the requested value`,
      ),
      {
        code: 'ASC_INPUT_MISMATCH',
        field: label,
        pageUrl: page.url(),
        expectedLength: value.length,
        observedLength: observed.length,
      },
    );
  }
}

// Open the build picker and select BUILD_NUMBER (or the newest row). Returns
// true once a build is confirmed into the version, false if none selectable.
async function selectBuild(s) {
  const opened = await clickAny(
    s,
    [
      'button:has-text("Add Build")',
      'button:has-text("Select a build")',
      'button[aria-label*="Add Build" i]',
      'button[aria-label*="build" i]',
    ],
    'open build picker',
  );
  if (!opened) {
    console.log(
      '[asc-submit] WARN: build picker control not found — version may already have a build',
    );
    return true;
  }
  await pageSettled(s.page);
  let row;
  if (BUILD_NUMBER) {
    row = s.page
      .locator(
        `tr:has-text("${BUILD_NUMBER}"), [role="row"]:has-text("${BUILD_NUMBER}"), label:has-text("${BUILD_NUMBER}")`,
      )
      .first();
  } else {
    row = s.page
      .locator('table tbody tr, [role="row"], input[type="radio"]')
      .first();
  }
  if (!(await row.isVisible().catch(() => false))) return false;
  await humanClickLocator(s.page, row);
  console.log(
    `[asc-submit] build selected: ${BUILD_NUMBER || 'newest available'}`,
  );
  await clickAny(
    s,
    [
      'button:has-text("Done")',
      'button:has-text("Add")',
      'button:has-text("Select")',
    ],
    'confirm build',
  );
  await pageSettled(s.page);
  return true;
}

const s = await WSession.start({
  label: 'apple_asc_submit',
  proxy: process.env.PROXY_URL || undefined,
});
try {
  await s.goto(DIST_URL);
  await pageSettled(s.page);
  if ((s.page.url?.() ?? '').includes('idmsa.apple.com')) {
    console.log('FAIL: session expired, rerun apple/login.mjs');
    process.exit(2);
  }

  // 1) Ensure an editable version exists. If VERSION_STRING is set and the
  //    page shows no "Prepare for Submission" version, create one.
  const hasEditable = await s.page
    .locator('text=/Prepare for Submission/i')
    .first()
    .isVisible()
    .catch(() => false);
  if (!hasEditable && VERSION_STRING) {
    console.log(`[asc-submit] no editable version, creating ${VERSION_STRING}`);
    const opened = await clickAny(
      s,
      [
        'button:has-text("Version or Platform")',
        'button[aria-label*="Add version" i]',
        'button:has-text("+")',
      ],
      'add version',
    );
    if (opened) {
      await pageSettled(s.page);
      const vField = s.page
        .locator(
          'input[placeholder*="ersion" i], input[name*="version" i], input[type="text"]',
        )
        .first();
      if (await vField.isVisible()) {
        await fillObserved(s.page, vField, VERSION_STRING, 'version');
        await clickAny(
          s,
          [
            'button:has-text("Create")',
            'button:has-text("Add")',
            'button:has-text("Done")',
          ],
          'create version',
        );
        await pageSettled(s.page);
      } else {
        console.log(
          '[asc-submit] WARN: version input not found, continuing with current page',
        );
      }
    } else {
      console.log(
        '[asc-submit] WARN: add-version control not found, continuing with current page',
      );
    }
  }

  // 2) What's New (optional).
  if (WHATS_NEW) {
    const wn = s.page
      .locator(
        'textarea[name="whatsNew"], textarea[data-test-id*="whatsNew"], textarea[aria-label*="New in This Version" i], textarea[aria-label*="What" i]',
      )
      .first();
    if (await wn.isVisible()) {
      await fillObserved(s.page, wn, WHATS_NEW, 'release notes');
      console.log(
        `[asc-submit] What's New entered (${WHATS_NEW.length} chars)`,
      );
    } else {
      console.log("[asc-submit] WARN: What's New field not found");
    }
  }

  // 3) Attach a build. When we just uploaded one, App Store Connect processes
  //    it server-side before it becomes selectable, so poll-reload until it
  //    appears. Without an upload, a single attempt is correct.
  let buildSelected = await selectBuild(s);
  if (!buildSelected && !IPA_PATH) {
    console.log(
      'FAIL: no processed build available to attach (set IPA_PATH to auto-upload one)',
    );
    process.exit(3);
  }
  // retry-allowed: reload App Store Connect until the altool-uploaded build
  // finishes processing and is selectable. Apple decides how long processing
  // takes; the run shows each reload, and the operator cancels a build that
  // never finishes.
  for (let reloads = 1; !buildSelected; reloads += 1) {
    console.log(`[asc-submit] build still processing, reload #${reloads}`);
    await s.goto(DIST_URL);
    await pageSettled(s.page);
    buildSelected = await selectBuild(s);
  }

  // Save any staged edits before submitting.
  await clickAny(
    s,
    ['button:has-text("Save")', 'button[data-test-id="save"]'],
    'save',
  );
  await pageSettled(s.page);

  if (!SUBMIT) {
    console.log(
      `PASS: staged version for app ${APP_ID} (SUBMIT=0, not sent to review)`,
    );
    process.exit(0);
  }

  // 4) Terminal submit. Modern ASC: "Add for Review" -> review summary ->
  //    "Submit for Review"/"Submit to App Review". Older ASC: single button.
  await clickAny(s, ['button:has-text("Add for Review")'], 'Add for Review');
  await pageSettled(s.page);

  const submitted = await clickAny(
    s,
    [
      'button:has-text("Submit for Review")',
      'button:has-text("Submit to App Review")',
      'button:has-text("Submit")',
    ],
    'Submit for Review',
  );
  if (!submitted) {
    let labels = [];
    try {
      labels = await s.page.evaluate(() =>
        Array.from(document.querySelectorAll('button'))
          .map((b) => (b.textContent || '').trim())
          .filter((t) => t.length),
      );
    } catch (e) {
      console.log('[asc-submit] button probe failed:', e.message);
    }
    console.log('[asc-submit] buttons on page:', JSON.stringify(labels));
    console.log('FAIL: terminal Submit-for-Review button not found');
    process.exit(1);
  }
  await pageSettled(s.page);

  // 5) Verify the version moved into a waiting/in-review status. Best-effort:
  //    the submit click already succeeded, so a read error here does not undo it.
  let status = '';
  try {
    status = await s.page.evaluate(() => {
      const m = (document.body?.innerText || '').match(
        /Waiting for Review|In Review|Pending Developer Release|Preparing for Submission|Processing for App Store|Ready for (Distribution|Sale)/i,
      );
      return m ? m[0] : '';
    });
  } catch (e) {
    console.log('[asc-submit] status read failed:', e.message);
  }
  if (status) {
    console.log(`PASS: app ${APP_ID} submitted — status now "${status}"`);
    process.exit(0);
  }
  console.log(
    `PASS: app ${APP_ID} submit-for-review clicked (status text not confirmed on page)`,
  );
  process.exit(0);
} catch (error) {
  console.error('FAIL:', error);
  process.exitCode = 1;
} finally {
  await s.close();
}
