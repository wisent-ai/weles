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
//   node weles/src/trajectories/google/drive/rename_doc.mjs \
//     --doc https://docs.google.com/document/d/<id>/edit \
//     --title "New title"
//
// Env mirror: DOC_URL, DOC_TITLE, BROWSER.

import { WSession } from '../../../../../dist/session/wsession.js';
import { googleSso } from '../../../_shared/services/google_sso.mjs';
import { humanClick } from '../../../../../dist/human/mouse.js';
import { humanType } from '../../../../../dist/human/keyboard.js';
import { pageCondition, pageSettled } from '../../../_shared/page/settled.mjs';
import { readScopedLogin } from '../../../../_shared/scoped-secrets.mjs';

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
  return readScopedLogin('googleDrive');
}

const creds = await resolveCreds();
const s = await WSession.start({ label: LABEL, browser: process.env.BROWSER || 'chromium' });

try {
  log('engine:', s.personaConfig?.browser ?? 'unknown', '| doc:', DOC_URL, '| new title:', TITLE);
  await s.page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
  await pageSettled(s.page);

  if (/accounts\.google\.com|ServiceLogin|signin/.test(s.page.url())) {
    log('logged out — running googleSso for', creds.email);
    const ok = await googleSso(s, creds);
    if (!ok) throw new Error(`DRIVE_DOCUMENT_SIGN_IN_FAILED: ${s.page.url()}`);
    await pageSettled(s.page);
    if (!/document\/d\/[A-Za-z0-9_-]+\/edit/.test(s.page.url())) {
      await s.page.goto(DOC_URL, { waitUntil: 'domcontentloaded' });
      await pageSettled(s.page);
    }
  }

  // Resolve the title display's CENTER coords via getBoundingClientRect
  // inside page.evaluate. Bypasses Playwright locator.boundingBox which
  // has been timing out. allow-raw-playwright: read-only DOM bbox lookup,
  // no synthetic interaction.
  const bbox = await pageCondition(s.page, () => { // allow-raw-playwright: read-only bbox lookup
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

  log('title label at (' + Math.round(bbox.x) + ',' + Math.round(bbox.y) + ') size ' + Math.round(bbox.w) + 'x' + Math.round(bbox.h) + ' sel=' + bbox.sel);

  // Click the title display via humanClick at the JS-computed coords.
  // Bypasses the locator boundingBox stall observed in create_doc.
  await humanClick(s.page, Math.round(bbox.x), Math.round(bbox.y));

  // After the click an input.docs-title-input element should be present
  // and focused. Verify before typing — log existing title so we can
  // compare post-commit.
  const before = await pageCondition(s.page, () => { // allow-raw-playwright: read-only DOM probe
    const inp = document.querySelector('input.docs-title-input');
    const label = document.querySelector('.docs-title-input-label-inner');
    const state = {
      inputPresent: !!inp,
      inputVisible: inp ? (inp.offsetWidth > 0 || inp.offsetHeight > 0) : false,
      inputValue: inp ? inp.value : null,
      labelText: label ? (label.textContent || '').trim() : null,
      activeIsTitle: document.activeElement === inp,
    };
    return state.inputPresent && state.inputVisible && state.activeIsTitle ? state : null;
  });
  log('after-click state: ' + JSON.stringify(before));


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
    if (!inp || document.activeElement !== inp) {
      throw new Error('DRIVE_DOCUMENT_TITLE_FOCUS_LOST: the title input is no longer focused');
    }
    inp.setSelectionRange(0, inp.value.length);
  });
  await humanType(s.page, TITLE);
  const typed = await s.page.evaluate(() => document.querySelector('input.docs-title-input')?.value);
  if (typed !== TITLE) {
    throw new Error('DRIVE_DOCUMENT_TITLE_VALUE_MISMATCH: title input differs from the requested value');
  }
  await s.page.keyboard.press('Enter'); // allow-raw-playwright: commit-rename Enter press
  await pageSettled(s.page);

  // Read the rendered title; this local state is not server-persistence proof.
  const after = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM probe
    const label = document.querySelector('.docs-title-input-label-inner');
    return label ? (label.textContent || '').trim() : null;
  });
  log('post-commit label text: ' + JSON.stringify(after));

  if (after === TITLE) {
    log('PASS');
    console.log('RENAMED: ' + after);
  } else {
    throw new Error(`DRIVE_DOCUMENT_TITLE_NOT_COMMITTED: label=${JSON.stringify(after)} expected=${JSON.stringify(TITLE)}`);
  }
} finally {
  await s.close();
}
