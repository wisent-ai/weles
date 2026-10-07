// overleaf/list_auto.mjs — fully-automated Overleaf dashboard scrape.
//
// Sources the shared Google SSO credentials from the
// weles service_credentials Supabase table via getGoogleSsoCreds(), opens an
// Overleaf session, drives "Sign in with Google" end-to-end via the existing
// _shared/services/google_sso.mjs helper, then scrapes the project dashboard.
// No manual login at any point.
//
// Pattern modeled on src/trajectories/oxylabs/topup.mjs.
//
// Env vars honored:
//   HEADLESS                 '1' = headless (default: visible window for
//                            debug; Google sometimes prefers a visible
//                            window for non-bot heuristics)
//   OVERLEAF_LIST_LIMIT      cap rows scraped (default 500)
//   OVERLEAF_LIST_INCLUDE    comma list: archived,trashed (default: none)
//   OUT_JSONL                file path to write JSONL stream (default stdout)
//
// Output: JSONL on stdout, one project per line, oldest-first by lastUpdated.
//         Recent-first summary table to stderr.
//
// Exit codes:
//   0 success; 1 no creds / no SSO completion; 2 page error (snapshot saved).

import { WSession } from '../../../../dist/session/wsession.js';
import { getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { overleafGoogleSignIn } from '../../_shared/services/overleaf_google_sign_in.mjs';
import { createWriteStream } from 'node:fs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

const LIMIT    = Number(process.env.OVERLEAF_LIST_LIMIT || 500);
const INCLUDES = new Set((process.env.OVERLEAF_LIST_INCLUDE || '').split(',').map(s => s.trim()).filter(Boolean));
const OUT      = process.env.OUT_JSONL ? createWriteStream(process.env.OUT_JSONL) : process.stdout;

const login = await getGoogleSsoCreds();
if (!login) {
  console.error('FAIL: exact weles-google-sso-login grant unavailable.');
  process.exit(1);
}
console.log(`[list_auto] Google creds loaded for ${login.email}`);

const s = await WSession.start({
  label: 'overleaf_list_auto',
  browser: 'chromium',
  headful: process.env.HEADLESS !== '1',
});

let pageError = null;
const rows = [];

try {
  // A stored cookie jar that already authenticates skips the SSO; otherwise
  // the shared sign-in drives Google and throws with the URL when Overleaf
  // rejects the OAuth callback.
  const signedIn = await overleafGoogleSignIn(s, login, { label: 'list_auto' });
  if (!signedIn.alreadySignedIn && !/\/project(\?|$|\/)/.test(signedIn.url)) {
    await s.goto('https://www.overleaf.com/project');
  }

  // Wait for project anchors. Each row in Overleaf's dashboard contains an
  // anchor pointing to /project/<24hex>; the anchor itself is the most
  // stable identifier across UI versions.
  const anchorSel = 'a[href*="/project/"]';
  await s.page.locator(anchorSel).first().waitFor({ state: 'visible' });

  // Scroll progressively until anchor count stabilizes.
  let seen = 0;
  let stable = 0;
  const anchorLoc = s.page.locator(anchorSel);
  while (seen < LIMIT && stable < 5) {
    const current = await anchorLoc.count();
    if (current === 0) {
      throw new Error('no project anchors visible on dashboard');
    }
    const isStable = current === seen;
    stable = isStable ? stable + 1 : 0;
    seen = current;
    const last = anchorLoc.nth(current - 1);
    await last.scrollIntoViewIfNeeded();
  }
  const total = Math.min(seen, LIMIT);
  console.log(`[list_auto] project anchors found: ${total}`);

  // Page-side scrape. Uses explicit null returns when fields are missing;
  // the calling Node process decides what to do with nulls.
  const scraped = await s.page.evaluate(({ sel, cap }) => {
    function textOrNull(el) {
      if (!el) return null;
      const t = el.textContent;
      if (!t) return null;
      const trimmed = t.trim();
      return trimmed === '' ? null : trimmed;
    }
    function attrOrNull(el, name) {
      if (!el) return null;
      const v = el.getAttribute(name);
      if (v === null || v === '') return null;
      return v;
    }
    function pickName(anchor, row) {
      const a = textOrNull(anchor);
      if (a !== null) return a;
      if (!row) return null;
      return textOrNull(row.querySelector('[data-testid="project-name"], h3, .project-name'));
    }
    function pickLastUpdated(row) {
      if (!row) return null;
      const tEl = row.querySelector('time');
      const attr = attrOrNull(tEl, 'datetime');
      if (attr !== null) return attr;
      return textOrNull(tEl);
    }
    const links = Array.from(document.querySelectorAll(sel)).slice(0, cap);
    const byId = new Map();
    for (const a of links) {
      const href = a.getAttribute('href');
      if (!href) continue;
      const m = href.match(/\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/);
      if (!m) continue;
      const id = m[1];
      if (byId.has(id)) continue;
      // The row is the largest ancestor that links to no other project: the
      // list's own markup bounds it, so no depth is chosen. The selector
      // matches only links that carry an href.
      const otherProject = (node) => Array.from(node.querySelectorAll('a[href*="/project/"]'))
        .some((link) => !link.getAttribute('href').includes(`/project/${id}`));
      let row = a;
      while (row.parentElement && !otherProject(row.parentElement)) row = row.parentElement;
      byId.set(id, {
        id,
        name: pickName(a, row),
        lastUpdated: pickLastUpdated(row),
        owner: row ? textOrNull(row.querySelector('[data-testid="project-owner"], .owner-name')) : null,
        ownerEmail: row ? textOrNull(row.querySelector('[data-testid="project-owner-email"]')) : null,
        archived: !!(row && row.closest && row.closest('[data-testid="archived-projects"], [data-filter="archived"]')),
        trashed: !!(row && row.closest && row.closest('[data-testid="trashed-projects"], [data-filter="trashed"]')),
      });
    }
    return Array.from(byId.values());
  }, { sel: anchorSel, cap: total });

  for (const r of scraped) {
    if (!r.id) continue;
    if (r.archived && !INCLUDES.has('archived')) continue;
    if (r.trashed && !INCLUDES.has('trashed')) continue;
    rows.push(r);
  }

  rows.sort((a, b) => String(a.lastUpdated || '').localeCompare(String(b.lastUpdated || '')));
  for (const r of rows) OUT.write(JSON.stringify(r) + '\n');

  const recent = [...rows].reverse().slice(0, 25);
  process.stderr.write(`\n==== Overleaf dashboard (${rows.length} projects scraped) ====\n`);
  process.stderr.write(`  id                        lastUpdated              name\n`);
  for (const r of recent) {
    process.stderr.write(`  ${(r.id || '-').padEnd(24)}  ${(r.lastUpdated || '-').padEnd(22)}  ${r.name || '-'}\n`);
  }
  if (rows.length > recent.length) {
    process.stderr.write(`  ... ${rows.length - recent.length} older not shown\n`);
  }
} catch (err) {
  pageError = err;
  console.error('[list_auto] error:', err?.message || err);
  try {
    // s.snapshot() doesn't exist on WSession; use the page screenshot API and
    // write beside the run's recordings so the artifact-inspection helpers find it.
    const snapPath = `${runRecordingsDir('overleaf_list_auto')}/overleaf_list_auto_failure.png`;
    await s.page.screenshot({ path: snapPath, fullPage: true });
    console.error(`[list_auto] failure screenshot: ${snapPath}`);
  } catch (snapErr) {
    console.error('[list_auto] snapshot also failed:', snapErr?.message || snapErr);
  }
}

if (OUT !== process.stdout) OUT.end();
await s.close();
if (pageError) process.exit(2);
process.exit(0);
