// overleaf/io/trash_projects.mjs — trash the junk "wrapfast-backend" Overleaf
// projects created by the earlier import-selector bug. Reuses pull_github.mjs's
// PROVEN Google-SSO + dashboard scaffold. After auth it scrapes the dashboard,
// selects ONLY projects whose title is exactly "wrapfast-backend", reads the
// Overleaf CSRF token from the page, and POSTs /project/<id>/trash for each via
// the authenticated context request. It can never touch a real paper because it
// matches the exact junk title. Trashed projects are recoverable from Overleaf
// Trash — nothing is permanently deleted.
//
// Usage: node scripts/trajectories/overleaf/io/trash_projects.mjs [<exactTitle>]
//   exactTitle defaults to "wrapfast-backend".
// Exit: 0 done; 1 no creds / SSO failed; 2 a UI step failed.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const TARGET_TITLE = (process.argv[2] || 'wrapfast-backend').trim();
const SHOT_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/trash_projects`;
mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(s, tag) {
  shotN += 1;
  const p = `${SHOT_DIR}/${String(shotN).padStart(2, '0')}_${tag}.html`;
  writeFileSync(p, await s.page.content());
  console.log(`[trash_projects] [${tag}] DOM ${p}`);
  return p;
}

const login = await getGoogleSsoCreds();
if (!login) { console.error('FAIL: getGoogleSsoCreds() returned null.'); process.exit(1); }
console.log(`[trash_projects] Google creds loaded for ${login.email}; target title = "${TARGET_TITLE}"`);

const s = await WSession.start({ label: 'trash_projects', browser: 'chromium', headful: process.env.HEADLESS !== '1' });

try {
  await s.goto('https://www.overleaf.com/login');
  await humanIdlePause('short');
  if (!/\/project(\?|$|\/)/.test(s.page.url())) {
    const cookieBtn = s.page.getByRole('button', { name: /essential cookies only|accept all cookies/i }).first();
    if (await cookieBtn.count() > 0) { await humanClickLocator(s.page, cookieBtn); await s.page.waitForTimeout(500); }  // allow-raw-playwright: cookie settle
    const googleBtn = s.page.getByRole('button', { name: /log in with google|sign in with google/i })
      .or(s.page.getByRole('link', { name: /log in with google|sign in with google/i })).first();
    await googleBtn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, googleBtn);
    let popup = null;
    for (let i = 0; i < 20 && !popup; i += 1) {
      for (const p of s.ctx.pages()) { if (p !== s.page && /accounts\.google\.com/.test(p.url())) { popup = p; break; } }
      if (popup) break;
      if (/accounts\.google\.com/.test(s.page.url())) break;
      await s.page.waitForTimeout(250);  // allow-raw-playwright: SSO-surface poll
    }
    const ok = popup
      ? (await popup.waitForLoadState('domcontentloaded'), await googleSso(s, login, { originHost: 'overleaf.com', page: popup }))
      : await googleSso(s, login, { originHost: 'overleaf.com' });
    if (!ok) { console.error('FAIL: Google SSO did not complete'); await s.close(); process.exit(1); }
    let prev = ''; let stable = 0;
    for (let i = 0; i < 60; i += 1) {
      await s.page.waitForTimeout(500);  // allow-raw-playwright: settle poll
      const u = s.page.url();
      if (u !== prev) { prev = u; stable = 0; continue; }
      stable += 1;
      if (stable >= 3 && !/accounts\.google\.com/.test(u)) break;
    }
  }
  if (!/\/project(\?|$|\/)/.test(s.page.url())) await s.goto('https://www.overleaf.com/project');
  await humanIdlePause('short');
  await shot(s, 'dashboard');

  // CSRF token used by the authenticated trash request.
  const csrf = await s.page.evaluate(() => {
    if (window.csrfToken) return window.csrfToken;
    const m = document.querySelector('meta[name="ol-csrfToken"]');
    return m ? m.getAttribute('content') : null;
  });
  if (!csrf) { console.error('[trash_projects] STEP FAILED: no CSRF token on dashboard'); await shot(s, 'fail_csrf'); await s.close(); process.exit(2); }
  console.log(`[trash_projects] CSRF token acquired (${csrf.length} chars)`);

  // Scrape all dashboard projects {id,title}.
  await s.page.locator('a[href*="/project/"]').first().waitFor({ state: 'visible' });
  const projects = await s.page.evaluate(() => {
    const seen = new Map();
    for (const a of Array.from(document.querySelectorAll('a[href*="/project/"]'))) {
      const href = a.getAttribute('href'); if (!href) continue;
      const m = href.match(/\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/); if (!m) continue;
      const id = m[1]; const title = a.textContent.trim();
      if (!seen.has(id) && title) seen.set(id, title);
    }
    return Array.from(seen.entries()).map(([id, title]) => ({ id, title }));
  });
  const targets = projects.filter((p) => p.title === TARGET_TITLE);
  console.log(`[trash_projects] ${projects.length} projects on dashboard; ${targets.length} match title "${TARGET_TITLE}"`);

  const results = [];
  for (const t of targets) {
    let ok = false; let status = 0;
    try {
      const resp = await s.ctx.request.post(`https://www.overleaf.com/project/${t.id}/trash`, {
        headers: { 'x-csrf-token': csrf, accept: 'application/json' },
      });
      status = resp.status();
      ok = resp.ok();
    } catch (e) {
      console.error(`[trash_projects] ${t.id} error: ${e && e.message ? e.message : e}`);
    }
    results.push({ id: t.id, ok, status });
    console.log(`[trash_projects] TRASH ${t.id} -> ${ok ? 'OK' : 'HTTP ' + status}`);
  }
  writeFileSync(`${SHOT_DIR}/_trash_results.json`, JSON.stringify(results, null, 2));
  const good = results.filter((r) => r.ok).length;
  console.log(`\n[trash_projects] OK — trashed ${good}/${results.length} "${TARGET_TITLE}" project(s)`);
  await s.close();
  process.exit(0);
} catch (err) {
  console.error('[trash_projects] unhandled error:', err && err.message ? err.message : err);
  await shot(s, 'exception');
  await s.close();
  process.exit(2);
}
