// App Store review (iOS): drives the App Store app on the physical iPhone at
// http://10.0.0.234:8100 (WebDriverAgent) to submit a review. Use this when
// the web flow at apps.apple.com refuses (storefront restriction, Apple ID
// not registered for web review, the modal redirects to idmsa for stale
// cookies).
//
// PRECONDITIONS (manual, one-time per device):
//   1. WebDriverAgent running on the iPhone (`scripts/lib/iphone-control.py wda start`).
//   2. iPhone unlocked (`iphone-control.py unlock`) and Auto-Lock = Never.
//   3. An Apple ID is already signed in inside the App Store app (Settings →
//      [Apple ID] → Media & Purchases). One Apple ID per device at a time;
//      switching personas is a manual sign-out/sign-in.
//   4. The target app must be installed or previously installed on this Apple
//      ID — Apple gates reviews behind ownership for most app categories.
//
// Args: APP_ID (numeric), RATING (1-5), TITLE, REVIEW_TEXT,
//       WDA_URL (override, default http://10.0.0.234:8100).

import { getSocialAccount } from '../../../../dist/utils/credentials.js';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

const APP_ID = process.env.APP_ID;
const RATING = parseInt(process.env.RATING || '5', 10);
const TITLE = process.env.TITLE || 'Great app';
const REVIEW_TEXT = process.env.REVIEW_TEXT || 'Works as expected. Recommend it.';
const WDA_URL = process.env.WDA_URL || 'http://10.0.0.234:8100';

if (!APP_ID) { console.log('FAIL: APP_ID env var required'); process.exit(1); }
if (!/^\d+$/.test(APP_ID)) { console.log('FAIL: APP_ID must be numeric'); process.exit(1); }
if (RATING < 1 || RATING > 5) { console.log('FAIL: RATING must be 1-5'); process.exit(1); }

// Informational only — the active Apple ID is whatever the device is signed
// in to. The account row is used for log/audit, not for credentials.
const acct = await getSocialAccount('apple');
if (acct) console.log(`[ios-review] expected Apple ID: ${acct.username} (${acct.metadata?.email ?? 'no email on row'})`);

const APP_STORE_BUNDLE = 'com.apple.AppStore';

async function wda(method, path, body) {
  const opts = { method, headers: body ? { 'Content-Type': 'application/json' } : {} };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${WDA_URL}${path}`, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON 5xx body */ }
  if (!res.ok) {
    const reason = json?.value?.message?.slice(0, 200) ?? text.slice(0, 200);
    throw new Error(`WDA ${method} ${path} → ${res.status}: ${reason}`);
  }
  return json;
}

async function ensureSession() {
  const status = await wda('GET', '/status');
  if (!status) throw new Error('WDA /status returned empty');
  const existing = status.sessionId;
  if (existing) return existing;
  const created = await wda('POST', '/session', { capabilities: { alwaysMatch: { bundleId: APP_STORE_BUNDLE } } });
  const sid = created?.value?.sessionId ?? created?.sessionId;
  if (!sid) throw new Error('failed to create WDA session');
  return sid;
}

async function activateAppStore(sid) {
  // /wda/apps/launch activates the App Store. If the app crashed or was
  // never opened, this also cold-starts it.
  await wda('POST', `/session/${sid}/wda/apps/launch`, { bundleId: APP_STORE_BUNDLE });
  await humanIdlePause('deliberate');
}

async function openAppListing(sid) {
  // The itms-apps deeplink opens the App Store app at the specific listing.
  // /url on iOS routes through Springboard and respects the foreground app.
  await wda('POST', `/session/${sid}/url`, { url: `itms-apps://apps.apple.com/app/id${APP_ID}` });
  await humanIdlePause('deliberate');
}

async function findFirst(sid, predicate) {
  const r = await wda('POST', `/session/${sid}/elements`, { using: 'predicate string', value: predicate });
  const list = r?.value ?? [];
  if (!list.length) return null;
  const e = list[0];
  return e.ELEMENT ?? e['element-6066-11e4-a52e-4f735466cecf'] ?? null;
}

async function tapElement(sid, eid) {
  await wda('POST', `/session/${sid}/element/${eid}/click`);
}

async function setElementValue(sid, eid, text) {
  // WDA's value endpoint accepts an array of strings or a single string. The
  // older protocol uses {"value": ["a","b",...]}; the W3C variant uses
  // {"text": "ab"}. Send both keys for compatibility across WDA versions.
  await wda('POST', `/session/${sid}/element/${eid}/value`, { value: text.split(''), text });
}

async function scrollToWriteReview(sid) {
  // Four drags from bottom-mid to top-mid usually reveal the Ratings &
  // Reviews section on a notch-iPhone in portrait. Coords are screen
  // pixels in iOS points (390x844 for iPhone 13/14/15 base sizes; WDA
  // scales for Pro Max automatically).
  for (let i = 0; i < 4; i++) {
    await wda('POST', `/session/${sid}/wda/dragfromtoforduration`, {
      fromX: 200, fromY: 700, toX: 200, toY: 200, duration: 0.5,
    });
    await humanIdlePause('short');
  }
  await humanIdlePause('deliberate');
}

async function dumpUiSource(sid, label) {
  try {
    const r = await wda('GET', `/session/${sid}/source`);
    const src = r?.value ?? '';
    console.log(`[ios-review] UI source dump (${label}, ${src.length} chars, first 4000):`);
    console.log(src.slice(0, 4000));
  } catch (e) {
    console.log(`[ios-review] UI source dump failed: ${e.message?.slice(0, 120)}`);
  }
}

let sid = null;
try {
  // 1. Health check + session.
  sid = await ensureSession();
  console.log(`[ios-review] session ${sid}`);

  // 2. Bring the App Store to the foreground and deeplink the listing.
  await activateAppStore(sid);
  await openAppListing(sid);

  // 3. Find Write a Review. Predicate matches the button by its visible
  // label. On some iOS versions the label is "Write a Review", on others
  // "Write Review"; the LIKE wildcard catches both.
  await scrollToWriteReview(sid);
  let writeBtn = await findFirst(sid, `name == "Write a Review"`);
  if (!writeBtn) writeBtn = await findFirst(sid, `name == "Write Review"`);
  if (!writeBtn) writeBtn = await findFirst(sid, `label LIKE '*Write*Review*'`);
  if (!writeBtn) {
    await dumpUiSource(sid, 'write-review-missing');
    console.log('FAIL: Write a Review button not found in App Store UI tree');
    process.exit(1);
  }
  await tapElement(sid, writeBtn);
  await humanIdlePause('deliberate');

  // 4. Sign-in modal. If the Apple ID isn't signed into Media & Purchases,
  // iOS shows a system sheet — we can't dismiss it programmatically because
  // the operator chose not to sign in. Fail loud so the operator notices.
  const signInPrompt = await findFirst(sid, `name == "Sign In" OR name == "Apple ID Password"`);
  if (signInPrompt) {
    await dumpUiSource(sid, 'sign-in-prompt');
    console.log('FAIL: App Store needs Apple ID sign-in via Settings → Media & Purchases (manual)');
    process.exit(2);
  }

  // 5. Star rating. The review sheet renders 5 stars as a row of buttons
  // labelled "1 star" .. "5 stars". Tap the Nth.
  const starName = RATING === 1 ? '1 star' : `${RATING} stars`;
  const starBtn = await findFirst(sid, `name == "${starName}"`);
  if (!starBtn) {
    await dumpUiSource(sid, 'stars-missing');
    console.log(`FAIL: rating button "${starName}" not found in review sheet`);
    process.exit(1);
  }
  await tapElement(sid, starBtn);
  await humanIdlePause('deliberate');

  // 6. Title field. The review sheet textfield labelled "Title" is the
  // top input.
  const titleField = await findFirst(sid, `type == "XCUIElementTypeTextField" AND (name == "Title" OR label == "Title")`);
  if (!titleField) {
    await dumpUiSource(sid, 'title-field-missing');
    console.log('FAIL: title text field not found');
    process.exit(1);
  }
  await tapElement(sid, titleField);
  await humanIdlePause('short');
  await setElementValue(sid, titleField, TITLE);
  await humanIdlePause('deliberate');

  // 7. Review body — a TextView, not TextField.
  const bodyField = await findFirst(sid, `type == "XCUIElementTypeTextView"`);
  if (!bodyField) {
    await dumpUiSource(sid, 'body-field-missing');
    console.log('FAIL: review body text view not found');
    process.exit(1);
  }
  await tapElement(sid, bodyField);
  await humanIdlePause('short');
  await setElementValue(sid, bodyField, REVIEW_TEXT);
  await humanIdlePause('deliberate');

  // 8. Submit. iOS labels the button "Send" in current App Store builds.
  let submitBtn = await findFirst(sid, `name == "Send"`);
  if (!submitBtn) submitBtn = await findFirst(sid, `name == "Submit"`);
  if (!submitBtn) {
    await dumpUiSource(sid, 'send-button-missing');
    console.log('FAIL: Send/Submit button not found');
    process.exit(1);
  }
  await tapElement(sid, submitBtn);
  await humanIdlePause('deliberate');

  // 9. Verify: the review sheet closes back to the listing on success.
  // An error alert ("Could not submit", "Try again") indicates server-side
  // rejection (account too new, app not owned, throttled).
  const errorAlert = await findFirst(sid, `name CONTAINS[c] "couldn't" OR name CONTAINS[c] "try again" OR name CONTAINS[c] "error"`);
  if (errorAlert) {
    await dumpUiSource(sid, 'submit-error-alert');
    console.log('FAIL: error alert visible after submit');
    process.exit(1);
  }

  console.log(`PASS: review submitted for app ${APP_ID} (${RATING}★) via iOS WDA`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 240));
  process.exit(1);
}
