// Search Google Drive for files matching a query string.
//
// Run:
//   node weles/src/trajectories/google/drive/search.mjs --q "grantland"
//
// Env mirror: GD_QUERY. Other env: GD_LIMIT, BROWSER.
//
// Output: JSON array on stdout with each result's title, url, fileId.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso } from '../../_shared/services/google_sso.mjs';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { readScopedLogin } from '../../../_shared/scoped-secrets.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const QUERY = arg('--q') || process.env.GD_QUERY;
const LIMIT = parseInt(process.env.GD_LIMIT || '50', 10);
const LABEL = 'drive_search';

if (!QUERY) {
  console.log('FAIL: --q (or GD_QUERY) required');
  process.exit(2);
}

function log(...a) {
  console.log('[drive_search]', ...a);
}

async function resolveCreds() {
  return readScopedLogin('googleDrive');
}

const creds = await resolveCreds();
// Chromium is the default engine — Firefox engine stalls at Google's
// password challenge page (same pattern as create_doc / list_docs).
const s = await WSession.start({
  label: LABEL,
  browser: process.env.BROWSER || 'chromium',
});

try {
  log('engine:', s.personaConfig?.browser ?? 'unknown', '| query:', QUERY);
  const url =
    'https://drive.google.com/drive/search?q=' + encodeURIComponent(QUERY);
  await s.page.goto(url, { waitUntil: 'domcontentloaded' });
  await pageSettled(s.page);

  if (/accounts\.google\.com|ServiceLogin|signin/.test(s.page.url())) {
    log('logged out — running googleSso for', creds.email);
    const ok = await googleSso(s, creds);
    if (!ok) throw new Error(`DRIVE_SEARCH_SIGN_IN_FAILED: ${s.page.url()}`);
    await pageSettled(s.page);
    await s.page.goto(url, { waitUntil: 'domcontentloaded' });
    await pageSettled(s.page);
  }

  // Observe rendered results or an explicit empty state without a read budget.
  let results = null;
  for (;;) {
    if (new URL(s.page.url()).hostname === 'accounts.google.com') {
      throw new Error(`DRIVE_SEARCH_SIGN_IN_REQUIRED: ${s.page.url()}`);
    }
    results = await s.page.evaluate(() => {
      // allow-raw-playwright: read-only DOM scrape of Drive search results, no synthetic interaction
      const empty = !!document.querySelector(
        '[aria-label*="No matching" i], [aria-label*="No files found" i]',
      );
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
        const iconNode = r.querySelector(
          '[role="img"][aria-label*="Google" i]',
        );
        if (iconNode) {
          const iconLabel = iconNode.getAttribute('aria-label');
          if (iconLabel) mimeIcon = iconLabel;
        }
        let docUrl = '';
        if (/Document/i.test(mimeIcon))
          docUrl = `https://docs.google.com/document/d/${id}/edit`;
        else if (/Spreadsheet/i.test(mimeIcon))
          docUrl = `https://docs.google.com/spreadsheets/d/${id}/edit`;
        else if (/Slides/i.test(mimeIcon))
          docUrl = `https://docs.google.com/presentation/d/${id}/edit`;
        else if (/Form/i.test(mimeIcon))
          docUrl = `https://docs.google.com/forms/d/${id}/edit`;
        else docUrl = `https://drive.google.com/file/d/${id}/view`;
        out.push({ fileId: id, title, mimeType: mimeIcon, url: docUrl });
      }
      return { empty: false, rows: out };
    });
    if (results && (results.empty || results.rows.length > 0)) break;
    await pageSettled(s.page);
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
