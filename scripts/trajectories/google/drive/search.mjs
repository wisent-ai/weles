// Search Google Drive for files matching a query string.
//
// Run:
//   node weles/scripts/trajectories/google/drive/search.mjs --q "grantland"
//
// Env mirror: GD_QUERY. Other env: GD_LIMIT, GM_EMAIL, GM_PASSWORD, BROWSER.
//
// Output: JSON array on stdout with each result's title, url, fileId.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanIdlePause } from '../../../../dist/human/mouse.js';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUERY = arg('--q') || process.env.GD_QUERY;
const LIMIT = parseInt(process.env.GD_LIMIT || '50', 10);
const LABEL = 'drive_search';

if (!QUERY) { console.log('FAIL: --q (or GD_QUERY) required'); process.exit(2); }

function log(...a) { console.log('[drive_search]', ...a); }

async function resolveCreds() {
  const email = process.env.GM_EMAIL || 'lukasz.bartoszcze@gmail.com';
  if (process.env.GM_PASSWORD) return { email, password: process.env.GM_PASSWORD };
  const fromDb = await getGoogleSsoCreds(email);
  if (fromDb?.password) return fromDb;
  throw new Error('No password: set GM_PASSWORD or add a service_credentials row for ' + email);
}

const creds = await resolveCreds();
// Chromium is the default engine — Firefox engine stalls at Google's
// password challenge page (same pattern as create_doc / list_docs).
const s = await WSession.start({ label: LABEL, browser: process.env.BROWSER || 'chromium' });

try {
  log('engine:', s.personaConfig?.browser ?? 'unknown', '| query:', QUERY);
  const url = 'https://drive.google.com/drive/search?q=' + encodeURIComponent(QUERY);
  await s.page.goto(url, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');

  if (/accounts\.google\.com|ServiceLogin|signin/.test(s.page.url())) {
    log('logged out — running googleSso for', creds.email);
    const ok = await googleSso(s, creds);
    if (!ok) { log('FAIL: googleSso did not complete (url=' + s.page.url() + ')'); process.exit(2); }
    await humanIdlePause('long');
    await s.page.goto(url, { waitUntil: 'domcontentloaded' });
    await humanIdlePause('deliberate');
  }

  // Wait for the results grid to hydrate. Drive uses [data-id="<fileId>"]
  // on each row. Poll for either rows OR an "empty results" marker.
  let results = null;
  for (let i = 0; i < 30; i++) {
    results = await s.page.evaluate(() => { // allow-raw-playwright: read-only DOM scrape of Drive search results, no synthetic interaction
      const empty = !!document.querySelector('[aria-label*="No matching" i], [aria-label*="No files found" i]');
      if (empty) return { empty: true, rows: [] };
      const rows = Array.from(document.querySelectorAll('[data-id]'));
      if (rows.length === 0) return null;
      const seen = new Set();
      const out = [];
      for (const r of rows) {
        const id = r.getAttribute('data-id');
        if (!id) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        // Title: aria-label on the row (first comma-separated chunk),
        // or data-tooltip on a child.
        let title = '';
        const ariaLabel = r.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.length > 0) {
          title = ariaLabel.split(',')[0].trim();
        }
        if (!title) {
          const tooltipNode = r.querySelector('[data-tooltip]');
          if (tooltipNode) {
            const tip = tooltipNode.getAttribute('data-tooltip');
            if (tip) title = tip.trim();
          }
        }
        // mimeType peek via Drive's icon aria-label; best-effort.
        let mimeIcon = '';
        const iconNode = r.querySelector('[role="img"][aria-label*="Google" i]');
        if (iconNode) {
          const iconLabel = iconNode.getAttribute('aria-label');
          if (iconLabel) mimeIcon = iconLabel;
        }
        let docUrl = '';
        if (/Document/i.test(mimeIcon)) docUrl = `https://docs.google.com/document/d/${id}/edit`;
        else if (/Spreadsheet/i.test(mimeIcon)) docUrl = `https://docs.google.com/spreadsheets/d/${id}/edit`;
        else if (/Slides/i.test(mimeIcon)) docUrl = `https://docs.google.com/presentation/d/${id}/edit`;
        else if (/Form/i.test(mimeIcon)) docUrl = `https://docs.google.com/forms/d/${id}/edit`;
        else docUrl = `https://drive.google.com/file/d/${id}/view`;
        out.push({ fileId: id, title, mimeType: mimeIcon, url: docUrl });
      }
      return { empty: false, rows: out };
    });
    if (results && (results.empty || results.rows.length > 0)) break;
    await humanIdlePause('short');
  }

  if (!results) {
    log('FAIL: results grid not loaded within timeout (url=' + s.page.url() + ')');
    process.exit(2);
  }

  if (results.empty) {
    log('MATCHES: 0');
    console.log('[]');
  } else {
    const limited = results.rows.slice(0, LIMIT);
    log('MATCHES: ' + limited.length);
    console.log(JSON.stringify(limited, null, 2));
  }
} finally {
  await s.close();
}
