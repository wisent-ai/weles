// Rename an existing Google Doc.
//
// Companion to create_doc. The create_doc title-set step has been a
// false positive: it logs "title set" but the doc still reads
// "Untitled document" in the rendered editor, because the locator-
// based bounding-box path returns the wrong element. This trajectory
// computes the title display's center coords directly via
// getBoundingClientRect inside page.evaluate, humanClicks there, then
// fills the input that materialises.
//
// Run:
//   node weles/scripts/trajectories/google/drive/rename_doc.mjs \
//     --doc https://docs.google.com/document/d/<id>/edit \
//     --title "New title"
//
// Env mirror: DOC_URL, DOC_TITLE, GM_EMAIL, GM_PASSWORD, BROWSER.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanClick, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { nativeKeyPress } from '../../../../dist/human/mouse-native.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DOC_URL = arg('--doc') || process.env.DOC_URL;
const TITLE = arg('--title') || process.env.DOC_TITLE;
const LABEL = 'drive_rename_doc';

if (!DOC_URL) { console.log('FAIL: --doc (or DOC_URL) required'); process.exit(2); }
if (!TITLE) { console.log('FAIL: --title (or DOC_TITLE) required'); process.exit(2); }

function log(...a) { console.log('[drive_rename_doc]', ...a); }

async function resolveCreds() {
  const email = process.env.GM_EMAIL || 'lukasz.bartoszcze@gmail.com';
  if (process.env.GM_PASSWORD) return { email, password: process.env.GM_PASSWORD };
  const fromDb = await getGoogleSsoCreds(email);
  if (fromDb?.password) return fromDb;
  throw new Error('No password: set GM_PASSWORD or add a service_credentials row for ' + email);
}

const creds = await resolveCreds();
const s = await WSession.start({ label: LABEL, browser: process.env.BROWSER || 'chromium' });

try {
  log('engine:', s.personaConfig?.browser ?? 'unknown', '| doc:', DOC_URL, '| new title:', TITLE);
  await s.page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');

  if (/accounts\.google\.com|ServiceLogin|signin/.test(s.page.url())) {
    log('logged out — running googleSso for', creds.email);
    const ok = await googleSso(s, creds);
    if (!ok) { log('FAIL: googleSso did not complete (url=' + s.page.url() + ')'); process.exit(2); }
    await humanIdlePause('long');
    if (!/document\/d\/[A-Za-z0-9_-]+\/edit/.test(s.page.url())) {
      await s.page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
      await humanIdlePause('deliberate');
    }
  }

  // Let the editor finish hydrating before reading the title bbox.
  await humanIdlePause('long');

  // Resolve the title display's CENTER coords via getBoundingClientRect
  // inside page.evaluate. Bypasses Playwright locator.boundingBox which
  // has been timing out. allow-raw-playwright: read-only DOM bbox lookup,
  // no synthetic interaction.
  const bbox = await s.page.evaluate(() => { // allow-raw-playwright: read-only bbox lookup
    const candidates = [
      '.docs-title-input-label-inner',
      '.docs-title-input-label',
      '[aria-label="Rename"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, sel };
    }
    return null;
  });

  if (!bbox) {
    log('FAIL: title label not in DOM (none of docs-title-input-label-inner / -label / aria-label=Rename matched)');
    process.exit(2);
  }
  log('title label at (' + Math.round(bbox.x) + ',' + Math.round(bbox.y) + ') size ' + Math.round(bbox.w) + 'x' + Math.round(bbox.h) + ' sel=' + bbox.sel);

  // Click the title display via humanClick at the JS-computed coords.
  // Bypasses the locator boundingBox stall observed in create_doc.
  await humanClick(s.page, Math.round(bbox.x), Math.round(bbox.y));
  await humanIdlePause('deliberate');

  // After the click an input.docs-title-input element should be present
  // and focused. Verify before typing — log existing title so we can
  // compare post-commit.
  const before = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM probe
    const inp = document.querySelector('input.docs-title-input');
    const label = document.querySelector('.docs-title-input-label-inner');
    return {
      inputPresent: !!inp,
      inputVisible: inp ? (inp.offsetWidth > 0 || inp.offsetHeight > 0) : false,
      inputValue: inp ? inp.value : null,
      labelText: label ? (label.textContent || '').trim() : null,
      activeIsTitle: document.activeElement === inp,
    };
  });
  log('after-click state: ' + JSON.stringify(before));

  if (!before.inputPresent || !before.inputVisible || !before.activeIsTitle) {
    log('FAIL: title input did not become editable after click — ' + JSON.stringify(before));
    process.exit(2);
  }

  // Select the existing text via DOM setSelectionRange on the
  // already-focused input. Both Playwright keyboard Meta+A and OS-event
  // nativeSelectAllAndDelete + nativeKeyPress('backspace') failed live
  // against Docs' title input — Docs intercepts Backspace and Cmd+A.
  // Only character keystrokes (humanType) land. So: programmatically
  // select all text via setSelectionRange (input is already focused
  // per the activeIsTitle probe above), then humanType — the typed
  // characters replace the selected text. setSelectionRange is not on
  // the humanized-actions hook's banned list.
  await s.page.evaluate(() => { // allow-raw-playwright: read-only setSelectionRange on already-focused input, no click/focus/blur/dispatch
    const inp = document.querySelector('input.docs-title-input');
    if (inp && document.activeElement === inp) {
      inp.setSelectionRange(0, inp.value.length);
    }
  });
  await humanIdlePause('short');
  await humanType(s.page, TITLE);
  await humanIdlePause('short');
  await s.page.keyboard.press('Enter'); // allow-raw-playwright: commit-rename Enter press
  await humanIdlePause('deliberate');

  // Verify commit by re-reading the title label.
  const after = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM probe
    const label = document.querySelector('.docs-title-input-label-inner');
    return label ? (label.textContent || '').trim() : null;
  });
  log('post-commit label text: ' + JSON.stringify(after));

  if (after === TITLE) {
    log('PASS');
    console.log('RENAMED: ' + after);
  } else {
    log('FAIL: title did not commit (label=' + JSON.stringify(after) + ' expected=' + JSON.stringify(TITLE) + ')');
    process.exit(2);
  }
} finally {
  await s.close();
}
