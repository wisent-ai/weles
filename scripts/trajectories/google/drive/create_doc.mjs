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
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { humanType, humanFill } from '../../../../dist/human/keyboard.js';
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
const s = await WSession.start({ label: LABEL, browser: process.env.BROWSER || undefined });

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

  // Try to set the title. Best-effort; non-fatal.
  try {
    const titleLabel = s.page.locator('.docs-title-input-label-inner, .docs-title-input-label, [aria-label*="Rename" i]').filter({ visible: true }).first();
    const labelVisible = await probeVisible(titleLabel);
    if (labelVisible) {
      await humanClickLocator(s.page, titleLabel);
      await humanIdlePause('short');
      const titleInput = s.page.locator('input.docs-title-input, input[aria-label*="Rename" i]').filter({ visible: true }).first();
      const inputVisible = await probeVisible(titleInput);
      if (inputVisible) {
        await humanFill(s.page, titleInput, TITLE);
        await s.page.keyboard.press('Enter'); // allow-raw-playwright: commit-title Enter press
        await humanIdlePause('deliberate');
        log('title set: ' + TITLE);
      } else {
        log('WARN: title input not editable; doc keeps default name');
      }
    } else {
      log('WARN: title label not found; doc keeps default name');
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
