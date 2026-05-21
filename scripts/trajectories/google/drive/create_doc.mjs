// Create a new Google Doc and insert markdown content via weles.
//
// Drives docs.google.com directly with a logged-in WSession. Replaces
// the claude.ai Google Drive MCP for users who don't want to go through
// the MCP OAuth dance — this trajectory uses the same googleSso helper
// as gmail_login_search.
//
// Run:
//   node weles/scripts/trajectories/google/drive/create_doc.mjs \
//     --title "My doc title" \
//     --content /abs/path/to/content.md
//
// Env (alternative to flags):
//   DOC_TITLE         document title
//   DOC_CONTENT_PATH  path to a UTF-8 text/markdown file
//   GM_EMAIL          google account (default lukasz.bartoszcze@gmail.com)
//   GM_PASSWORD       google account password (else sourced from service_credentials)
//   BROWSER           'chromium' | 'firefox' to pin engine
//
// Output:
//   URL: https://docs.google.com/document/d/<id>/edit on success.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanClick, humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanType, humanFill } from '../../../../dist/human/keyboard.js';
import { nativeSelectAllAndDelete } from '../../../../dist/human/mouse-native.js';
import { readFileSync } from 'node:fs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TITLE = arg('--title') || process.env.DOC_TITLE;
const CONTENT_PATH = arg('--content') || process.env.DOC_CONTENT_PATH;

if (!TITLE) { console.log('FAIL: --title (or DOC_TITLE) required'); process.exit(2); }
if (!CONTENT_PATH) { console.log('FAIL: --content (or DOC_CONTENT_PATH) required'); process.exit(2); }

const content = readFileSync(CONTENT_PATH, 'utf8');
const LABEL = 'drive_create_doc';

function log(...a) { console.log('[drive_create_doc]', ...a); }

async function resolveCreds() {
  const email = process.env.GM_EMAIL || 'lukasz.bartoszcze@gmail.com';
  if (process.env.GM_PASSWORD) return { email, password: process.env.GM_PASSWORD };
  const fromDb = await getGoogleSsoCreds(email);
  if (fromDb?.password) return fromDb;
  throw new Error('No password: set GM_PASSWORD or add a service_credentials row for ' + email);
}

const creds = await resolveCreds();
// Chromium is the default engine for this trajectory. Firefox passes
// Google SSO and produces a real doc, but the title input
// (input.docs-title-input) and body canvas (.kix-appview-editor) both
// time out on boundingBox under the Firefox engine — Docs renders
// those as canvas-backed controls Firefox's WSession can't resolve.
// Chromium fills title + body cleanly. Override with BROWSER=firefox
// only when probing engine parity.
const s = await WSession.start({ label: LABEL, browser: process.env.BROWSER || 'chromium' });

try {
  log('engine:', s.personaConfig?.browser ?? 'unknown', '| title:', TITLE, '| content_bytes:', content.length);

  // docs.google.com/document/create creates a new blank doc and
  // redirects to /document/d/<id>/edit when signed in. When signed
  // out, it lands on accounts.google.com first.
  await s.page.goto('https://docs.google.com/document/create', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');

  if (/accounts\.google\.com|ServiceLogin|signin/.test(s.page.url())) {
    log('logged out — running googleSso for', creds.email);
    const ok = await googleSso(s, creds);
    if (!ok) { log('FAIL: googleSso did not complete (url=' + s.page.url() + ')'); process.exit(2); }
    await humanIdlePause('long');
    // After login Google usually redirects back to the create URL, but if it
    // landed on the Drive home, force the create nav.
    if (!/document\/d\//.test(s.page.url())) {
      await s.page.goto('https://docs.google.com/document/create', { waitUntil: 'domcontentloaded' });
      await humanIdlePause('deliberate');
    }
  }

  // Wait for the doc to fully load — the URL flips to /document/d/<id>/edit
  // and the canvas iframe materialises. The docs editor uses a kix canvas
  // wrapped in iframes; the most reliable readiness signal is the document
  // title input rendering at the top.
  for (let i = 0; i < 60; i++) {
    if (/document\/d\/[A-Za-z0-9_-]+\/edit/.test(s.page.url())) break;
    await humanIdlePause('short');
  }
  if (!/document\/d\/[A-Za-z0-9_-]+\/edit/.test(s.page.url())) {
    log('FAIL: never landed on a new doc URL (url=' + s.page.url() + ')');
    process.exit(2);
  }
  const docUrl = s.page.url();
  const docIdMatch = docUrl.match(/document\/d\/([A-Za-z0-9_-]+)/);
  const docId = docIdMatch?.[1];
  log('doc created, id=' + docId);

  // Print the URL as the load-bearing result FIRST. Title + body
  // insertion below are best-effort. The first iteration hard-failed
  // when the Docs title-input locator's boundingBox call exceeded 30s
  // (modern Docs renders the title as a canvas-rendered control and
  // the legacy input.docs-title-input selector is no longer real). Now
  // the URL is committed to stdout before any fragile UI manipulation.
  console.log('URL: ' + docUrl);

  async function probeVisible(loc) {
    try { return await loc.isVisible(); }
    catch (e) {
      if (/detached|navigat|destroyed|closed/i.test(e.message || '')) return null;
      throw e;
    }
  }

  await humanIdlePause('long'); // let the Docs canvas finish hydrating

  // Set the title via coordinate-based humanClick. The Playwright
  // locator boundingBox path used here in the prior iteration would
  // sometimes match a wrong element or hang on boundingBox, producing
  // a "title set" log that the rendered UI later contradicted. The
  // companion rename_doc trajectory proved the JS getBoundingClientRect
  // + humanClick(x, y) flow works end-to-end on Chromium. Use the same
  // path here so create_doc's own title step verifies under the same
  // post-commit DOM probe.
  try {
    const bbox = await s.page.evaluate(() => { // allow-raw-playwright: read-only bbox lookup of the title label
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
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, sel };
      }
      return null;
    });
    if (!bbox) {
      log('WARN: title label not in DOM; doc keeps default name');
    } else {
      await humanClick(s.page, Math.round(bbox.x), Math.round(bbox.y));
      await humanIdlePause('deliberate');
      const after = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM probe of the title input state
        const inp = document.querySelector('input.docs-title-input');
        return {
          inputPresent: !!inp,
          inputVisible: inp ? (inp.offsetWidth > 0 || inp.offsetHeight > 0) : false,
          activeIsTitle: document.activeElement === inp,
        };
      });
      if (!after.inputPresent || !after.inputVisible || !after.activeIsTitle) {
        log('WARN: title input did not become editable after click — ' + JSON.stringify(after));
      } else {
        // Clear + type on the OS event queue (mixing Playwright
        // keyboard Cmd+A with nativeType humanType lands the keystrokes
        // in different focus contexts and the placeholder survives).
        nativeSelectAllAndDelete();
        await humanIdlePause('short');
        await humanType(s.page, TITLE);
        await humanIdlePause('short');
        await s.page.keyboard.press('Enter'); // allow-raw-playwright: commit-title Enter press
        await humanIdlePause('deliberate');
        const committed = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM probe of committed title
          const label = document.querySelector('.docs-title-input-label-inner');
          return label ? (label.textContent || '').trim() : null;
        });
        if (committed === TITLE) {
          log('title set: ' + TITLE);
        } else {
          log('WARN: title commit not verified (label=' + JSON.stringify(committed) + ' expected=' + JSON.stringify(TITLE) + ')');
        }
      }
    }
  } catch (e) {
    log('WARN: title-set raised: ' + (e.message || String(e)).slice(0, 80));
  }

  // Try to insert body content. Best-effort; non-fatal. Canvas waitFor
  // uses Playwright's default visibility timeout (30s) — long enough for
  // first hydration, short enough to fail fast on a wrong selector.
  try {
    const canvas = s.page.locator('.kix-appview-editor, .docs-texteventtarget-iframe, [contenteditable="true"]').first();
    await canvas.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, canvas);
    await humanIdlePause('deliberate');
    log('typing ' + content.length + ' chars into body…');
    await humanType(s.page, content);
    await humanIdlePause('long');
    log('body typed');
  } catch (e) {
    log('WARN: body-insert raised: ' + (e.message || String(e)).slice(0, 80));
  }

  log('PASS: doc available at ' + docUrl);
} finally {
  await s.close();
}
