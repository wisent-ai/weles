// App Store review (iOS): drives the App Store app on a physical iPhone
// through WebDriverAgent, reached at WDA_URL, to submit a review. Use this
// when the web flow at apps.apple.com refuses (storefront restriction, Apple
// ID not registered for web review, a review form sent to Apple's sign-in).
//
// PRECONDITIONS (one-time per device):
//   1. WebDriverAgent running on the iPhone (`src/lib/iphone-control.py wda start`).
//   2. iPhone unlocked (`iphone-control.py unlock`) and Auto-Lock = Never.
//   3. An Apple ID signed in inside the App Store app (Settings → [Apple ID]
//      → Media & Purchases); one Apple ID per device at a time.
//   4. The app installed, or once installed, on that Apple ID: Apple gates
//      reviews behind ownership for most app categories.
//
// Inputs: APP_ID (numeric), RATING (stars), TITLE, REVIEW_TEXT and WDA_URL
// (the WebDriverAgent address of the phone this run drives), all required.
// A step whose element the review sheet does not show fails by name, with
// the UI tree kept in the run's recordings.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSocialAccount } from '../../../../dist/utils/credentials.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { statedText } from '../../_shared/inputs/stated.mjs';

const LABEL = 'apple_ios_appstore_review';
const APP_ID = statedText(
  ['APP_ID'],
  'the numeric App Store id of the app reviewed',
);
if (!/^\d+$/.test(APP_ID))
  throw new Error(`APP_ID must be the numeric App Store id; it is "${APP_ID}"`);
const RATING = Number(
  statedText(['RATING'], 'the star rating the review gives'),
);
if (!Number.isSafeInteger(RATING) || !(RATING >= Number.MIN_VALUE))
  throw new Error(
    `RATING must be a whole number of stars; it is "${process.env.RATING}"`,
  );
const TITLE = statedText(['TITLE'], 'the title of the review');
const REVIEW_TEXT = statedText(['REVIEW_TEXT'], 'the words of the review');
const WDA_URL = statedText(
  ['WDA_URL'],
  'the WebDriverAgent address of the phone this run drives',
);

// The device reviews as whatever Apple ID it is signed in to; the stored
// account is logged for the audit trail, not used as a credential.
const acct = await getSocialAccount('apple');
if (acct)
  console.log(
    `[ios-review] expected Apple ID: ${JSON.stringify({ username: acct.username, email: acct.metadata?.email })}`,
  );

const APP_STORE_BUNDLE = 'com.apple.AppStore';
// The W3C WebDriver key an element reference is answered under.
const W3C_ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

async function wda(method, path, body) {
  const res = await fetch(`${WDA_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = res.headers.get('content-type')?.includes('json')
    ? JSON.parse(text)
    : null;
  if (!res.ok)
    throw new Error(
      `WDA ${method} ${path} → ${res.status}: ${json?.value?.message ? json.value.message : text}`,
    );
  if (json === null)
    throw new Error(`WDA ${method} ${path} answered no JSON: ${text}`);
  return json;
}

// The session waits for the App Store to go idle before every element query
// and action (XCUITest quiescence, WebDriverAgent's shouldWaitForQuiescence),
// so each step reads the sheet the previous one left, as the app reports it,
// with no pause of this run's own.
async function ensureSession() {
  const status = await wda('GET', '/status');
  if (status.sessionId) return status.sessionId;
  const created = await wda('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        bundleId: APP_STORE_BUNDLE,
        shouldWaitForQuiescence: true,
      },
    },
  });
  const sid = created.value?.sessionId
    ? created.value.sessionId
    : created.sessionId;
  if (!sid)
    throw new Error(`WDA created no session: ${JSON.stringify(created)}`);
  return sid;
}

/** The first element `predicate` matches, or null when none does. */
async function findFirst(sid, predicate) {
  const { value } = await wda('POST', `/session/${sid}/elements`, {
    using: 'predicate string',
    value: predicate,
  });
  if (!Array.isArray(value))
    throw new Error(
      `WDA element search for ${predicate} answered no list: ${JSON.stringify(value)}`,
    );
  const [element] = value;
  if (!element) return null;
  return element.ELEMENT ? element.ELEMENT : element[W3C_ELEMENT];
}

async function tapElement(sid, eid) {
  await wda('POST', `/session/${sid}/element/${eid}/click`);
}

// WDA's value endpoint takes the older {"value": [...chars]} or the W3C
// {"text": "..."}; both keys are sent for every WDA version.
async function setElementValue(sid, eid, text) {
  await wda('POST', `/session/${sid}/element/${eid}/value`, {
    value: [...text],
    text,
  });
}

async function uiSource(sid) {
  return (await wda('GET', `/session/${sid}/source`)).value;
}

/** Throw `message`, with the UI tree kept in the run's recordings under `step`. */
async function failWithSource(sid, step, message) {
  const dir = runRecordingsDir(LABEL);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${step}.xml`);
  writeFileSync(file, await uiSource(sid));
  throw new Error(`${message} (UI tree kept in ${file})`);
}

// Scroll the listing one WDA page at a time until Write a Review is in the
// tree, observed rather than counted: a scroll that leaves the UI source
// unchanged means the listing ended without one.
async function scrollToWriteReview(sid) {
  const listing = await findFirst(
    sid,
    'type == "XCUIElementTypeCollectionView"',
  );
  if (!listing)
    await failWithSource(
      sid,
      'listing-missing',
      'the App Store listing shows no scrollable view',
    );
  let before = await uiSource(sid);
  for (;;) {
    const button = await findFirst(sid, "label LIKE[c] '*Write*Review*'");
    if (button) return button;
    await wda('POST', `/session/${sid}/wda/element/${listing}/scroll`, {
      direction: 'down',
    });
    const after = await uiSource(sid);
    if (after === before)
      await failWithSource(
        sid,
        'write-review-missing',
        'the listing scrolled to its end without a Write a Review button',
      );
    before = after;
  }
}

const sid = await ensureSession();
console.log(`[ios-review] session ${sid}`);

// The App Store in the foreground (cold-started when it was not running),
// then the listing through its itms-apps deeplink.
await wda('POST', `/session/${sid}/wda/apps/launch`, {
  bundleId: APP_STORE_BUNDLE,
});
await wda('POST', `/session/${sid}/url`, {
  url: `itms-apps://apps.apple.com/app/id${APP_ID}`,
});

await tapElement(sid, await scrollToWriteReview(sid));

// An Apple ID not signed in to Media & Purchases gets the system's password
// sheet, the only secure text field this flow can meet.
if (await findFirst(sid, 'type == "XCUIElementTypeSecureTextField"'))
  await failWithSource(
    sid,
    'sign-in-prompt',
    'the App Store asks for the Apple ID password: sign in under Settings → Media & Purchases',
  );

// The stars are buttons named "<n> star" / "<n> stars".
const star = await findFirst(
  sid,
  `type == "XCUIElementTypeButton" AND name BEGINSWITH "${RATING} star"`,
);
if (!star)
  await failWithSource(
    sid,
    'stars-missing',
    `the review sheet shows no ${RATING}-star button`,
  );
await tapElement(sid, star);

// The sheet's single-line text field is the title; its text view the body.
const titleField = await findFirst(sid, 'type == "XCUIElementTypeTextField"');
if (!titleField)
  await failWithSource(
    sid,
    'title-field-missing',
    'the review sheet shows no title field',
  );
await tapElement(sid, titleField);
await setElementValue(sid, titleField, TITLE);
const bodyField = await findFirst(sid, 'type == "XCUIElementTypeTextView"');
if (!bodyField)
  await failWithSource(
    sid,
    'body-field-missing',
    'the review sheet shows no body text view',
  );
await tapElement(sid, bodyField);
await setElementValue(sid, bodyField, REVIEW_TEXT);

const send = await findFirst(
  sid,
  'type == "XCUIElementTypeButton" AND name == "Send"',
);
if (!send)
  await failWithSource(
    sid,
    'send-button-missing',
    'the review sheet shows no Send button',
  );
await tapElement(sid, send);

// The sheet closes back to the listing on success; an alert over it is
// Apple's refusal (account too new, app not owned, throttled).
const alert = await findFirst(sid, 'type == "XCUIElementTypeAlert"');
if (alert)
  await failWithSource(
    sid,
    'submit-alert',
    'the App Store answered the review with an alert',
  );
// No alert is not yet success: a sheet the App Store kept open (a title too
// long, a field it marks in error) still shows its Send button.
const sheetStillOpen = await findFirst(
  sid,
  'type == "XCUIElementTypeButton" AND name == "Send"',
);
if (sheetStillOpen)
  await failWithSource(
    sid,
    'sheet-still-open',
    'the review sheet is still open after Send, so the App Store did not take the review',
  );
console.log(
  `PASS: review submitted for app ${APP_ID} (${RATING}★) via iOS WDA`,
);
