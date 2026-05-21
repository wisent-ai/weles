// List the signed-in user's recent Google Docs.
//
// Run:
//   node weles/scripts/trajectories/google/drive/list_docs.mjs
//
// Env:
//   GD_LIMIT    cap on result count (default 50)
//   GM_EMAIL    google account (default lukasz.bartoszcze@gmail.com)
//   GM_PASSWORD google account password (else service_credentials)
//   BROWSER     'chromium' | 'firefox'
//
// Output: JSON array on stdout, one entry per recent doc.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

const LIMIT = parseInt(process.env.GD_LIMIT || '50', 10);
const LABEL = 'drive_list_docs';

function log(...a) { console.log('[drive_list_docs]', ...a); }

async function resolveCreds() {
  const email = process.env.GM_EMAIL || 'lukasz.bartoszcze@gmail.com';
  if (process.env.GM_PASSWORD) return { email, password: process.env.GM_PASSWORD };
  const fromDb = await getGoogleSsoCreds(email);
  if (fromDb?.password) return fromDb;
  throw new Error('No password: set GM_PASSWORD or add a service_credentials row for ' + email);
}

const creds = await resolveCreds();
// Chromium is the default engine; Firefox engine stalls at Google's
// password challenge page (same root cause that broke Firefox in
// create_doc — Google's WIZ form doesn't surface a password input
// for the Gecko UA in some sessions). Override with BROWSER=firefox
// only when probing engine parity.
const s = await WSession.start({ label: LABEL, browser: process.env.BROWSER || 'chromium' });

try {
  log('engine:', s.personaConfig?.browser ?? 'unknown');
  await s.page.goto('https://docs.google.com/document/u/0/', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');

  if (/accounts\.google\.com|ServiceLogin|signin/.test(s.page.url())) {
    log('logged out — running googleSso for', creds.email);
    const ok = await googleSso(s, creds);
    if (!ok) { log('FAIL: googleSso did not complete (url=' + s.page.url() + ')'); process.exit(2); }
    await humanIdlePause('long');
    await s.page.goto('https://docs.google.com/document/u/0/', { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
  }

  // Wait for the recent-files grid to hydrate. The tiles are anchor tags
  // pointing at /document/d/<id>/edit, wrapped in a [data-id] container.
  let docs = [];
  for (let i = 0; i < 30; i++) {
    docs = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM scrape of the recent-docs grid, no synthetic interaction
      const anchors = Array.from(document.querySelectorAll('a[href*="/document/d/"]'));
      const seen = new Set();
      const out = [];
      for (const a of anchors) {
        const m = a.href.match(/\/document\/d\/([A-Za-z0-9_-]+)/);
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;
        seen.add(id);
        // The clickable tile wraps the title in a sibling element; walk
        // up to the [data-id] container and look for a title span.
        const tile = a.closest('[data-id], [jsname]') || a;
        const titleEl = tile.querySelector('[data-tooltip], .docs-homescreen-list-item-title, .doclist-document-name, span[aria-label]') || a;
        const titleText = (titleEl.getAttribute?.('aria-label') || titleEl.textContent || a.title || '').trim();
        out.push({ id, url: a.href.split('?')[0], title: titleText });
      }
      return out;
    });
    if (docs.length > 0) break;
    await humanIdlePause('short');
  }

  if (docs.length === 0) {
    log('FAIL: recent grid not loaded within timeout (url=' + s.page.url() + ')');
    process.exit(2);
  }

  const limited = docs.slice(0, LIMIT);
  log('PASS: ' + limited.length + ' docs');
  console.log(JSON.stringify(limited, null, 2));
} finally {
  await s.close();
}
