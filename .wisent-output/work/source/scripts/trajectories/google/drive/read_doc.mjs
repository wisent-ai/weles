// Read the plain-text body of an existing Google Doc.
//
// Uses Drive's /export?format=txt endpoint via the WSession's authenticated
// HTTP context (session cookies handle auth). Bypasses canvas-rendered
// editor scraping, which is brittle.
//
// Run:
//   node weles/scripts/trajectories/google/drive/read_doc.mjs --doc <url-or-id> [--out path]
//
// Env mirror: DOC_URL, DOC_ID. Other env: BROWSER.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso } from '../../_shared/services/google_sso.mjs';
import { humanIdlePause } from '../../../../dist/human/mouse.js';
import { writeFileSync } from 'node:fs';
import { readScopedLogin } from '../../../_shared/scoped-secrets.mjs';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DOC_INPUT = arg('--doc') || process.env.DOC_URL || process.env.DOC_ID;
const OUT_PATH = arg('--out');
const LABEL = 'drive_read_doc';

if (!DOC_INPUT) { console.log('FAIL: --doc (or DOC_URL / DOC_ID) required'); process.exit(2); }

function extractId(s) {
  const m = s.match(/\/document\/d\/([A-Za-z0-9_-]+)/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return null;
}

const DOC_ID = extractId(DOC_INPUT);
if (!DOC_ID) { console.log('FAIL: could not extract doc id from "' + DOC_INPUT + '"'); process.exit(2); }

function log(...a) { console.error('[drive_read_doc]', ...a); }

async function resolveCreds() {
  return readScopedLogin('googleDrive');
}

const creds = await resolveCreds();
const s = await WSession.start({ label: LABEL, browser: process.env.BROWSER || 'chromium' });

try {
  log('engine:', s.personaConfig?.browser ?? 'unknown', '| doc_id:', DOC_ID);
  await s.page.goto('https://docs.google.com/document/u/0/', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');

  if (/accounts\.google\.com|ServiceLogin|signin/.test(s.page.url())) {
    log('logged out — running googleSso for', creds.email);
    const ok = await googleSso(s, creds);
    if (!ok) { log('FAIL: googleSso did not complete (url=' + s.page.url() + ')'); process.exit(2); }
    await humanIdlePause('long');
  }

  const exportUrl = 'https://docs.google.com/document/d/' + DOC_ID + '/export?format=txt';
  log('fetching:', exportUrl);
  const resp = await s.page.context().request.get(exportUrl); // allow-raw-playwright: read-only export HTTP fetch via the page's authenticated context
  const status = resp.status();
  log('HTTP', status);
  if (status !== 200) {
    log('FAIL: HTTP ' + status);
    process.exit(2);
  }
  const body = await resp.text();
  log('body chars:', body.length);

  if (OUT_PATH) {
    writeFileSync(OUT_PATH, body);
    log('wrote ' + OUT_PATH);
    console.log('OK: wrote ' + body.length + ' chars to ' + OUT_PATH);
  } else {
    process.stdout.write(body);
  }
} finally {
  await s.close();
}
