// overleaf/io/download_all.mjs — inventory + source download for EVERY Overleaf
// project, reusing pull_github.mjs's PROVEN Google-SSO + dashboard scaffold.
// After auth it scrapes the dashboard for all {id,title} then downloads each
// project's source via the authenticated zip endpoint
// (/project/<id>/download/zip) using the context request (shares cookies),
// saving to .work/ol_sources/<id>.zip. Prints a JSON line per project so the
// caller gets the full id->title map for reconciliation against GitHub repos.
//
// Usage: node scripts/trajectories/overleaf/io/download_all.mjs
// Env: HEADLESS=1 headless (default visible).
// Exit: 0 all projects attempted; 1 no creds / SSO failed; 2 a UI step failed.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';

const OUT_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/ol_sources`;
const SHOT_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/download_all`;
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(s, tag) {
  shotN += 1;
  const p = `${SHOT_DIR}/${String(shotN).padStart(2, '0')}_${tag}.html`;
  const html = await s.page.content();
  writeFileSync(p, html);
  console.log(`[download_all] [${tag}] DOM ${p} (${html.length}b)`);
  return p;
}
async function dieUI(s, tag, msg) {
  console.error(`\n[download_all] STEP FAILED: ${tag} — ${msg}`);
  const p = await shot(s, `fail_${tag}`);
  console.error(`[download_all] FAIL (exit 2). Inspect ${p} — do not guess.`);
  await s.close();
  process.exit(2);
}

const login = await getGoogleSsoCreds();
if (!login) { console.error('FAIL: getGoogleSsoCreds() returned null.'); process.exit(1); }
console.log(`[download_all] Google creds loaded for ${login.email}`);

const s = await WSession.start({ label: 'download_all', browser: 'chromium', headful: process.env.HEADLESS !== '1' });

try {
  await s.goto('https://www.overleaf.com/login');
  await humanIdlePause('short');

  if (/\/project(\?|$|\/)/.test(s.page.url())) {
    console.log('[download_all] already authenticated via persisted cookies');
  } else {
    const cookieBtn = s.page.getByRole('button', { name: /essential cookies only|accept all cookies/i }).first();
    if (await cookieBtn.count() > 0) {
      console.log('[download_all] dismissing cookie banner');
      await humanClickLocator(s.page, cookieBtn);
      await s.page.waitForTimeout(500);  // allow-raw-playwright: cookie-banner settle
    }
    const googleBtn = s.page.getByRole('button', { name: /log in with google|sign in with google/i }).or(
      s.page.getByRole('link', { name: /log in with google|sign in with google/i })
    ).first();
    await googleBtn.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, googleBtn);

    let popup = null;
    for (let i = 0; i < 20 && !popup; i += 1) {
      for (const p of s.ctx.pages()) {
        if (p !== s.page && /accounts\.google\.com/.test(p.url())) { popup = p; break; }
      }
      if (popup) break;
      if (/accounts\.google\.com/.test(s.page.url())) break;
      await s.page.waitForTimeout(250);  // allow-raw-playwright: SSO-surface poll
    }

    if (popup) {
      console.log('[download_all] Google SSO in popup');
      await popup.waitForLoadState('domcontentloaded');
      const ok = await googleSso(s, login, { originHost: 'overleaf.com', page: popup });
      if (!ok) { console.error('FAIL: Google SSO did not complete (popup)'); await s.close(); process.exit(1); }
    } else {
      console.log('[download_all] Google SSO in-place redirect');
      const ok = await googleSso(s, login, { originHost: 'overleaf.com' });
      if (!ok) { console.error('FAIL: Google SSO did not complete (in-place)'); await s.close(); process.exit(1); }
    }

    let prev = '';
    let stableTicks = 0;
    let settledUrl = null;
    for (let i = 0; i < 60; i += 1) {
      await s.page.waitForTimeout(500);  // allow-raw-playwright: settle poll
      const u = s.page.url();
      if (u !== prev) { prev = u; stableTicks = 0; continue; }
      stableTicks += 1;
      if (stableTicks >= 3 && !/accounts\.google\.com/.test(u)) { settledUrl = u; break; }
    }
    const finalUrl = settledUrl || s.page.url();
    console.log(`[download_all] settled URL: ${finalUrl}`);
    if (/\/login(\?|$|\/)/.test(finalUrl)) {
      await dieUI(s, 'sso', `Overleaf returned to /login after SSO — ${finalUrl}`);
    }
  }

  if (!/\/project(\?|$|\/)/.test(s.page.url())) {
    await s.goto('https://www.overleaf.com/project');
  }
  await humanIdlePause('short');
  await shot(s, 'dashboard');

  const anchorSel = 'a[href*="/project/"]';
  await s.page.locator(anchorSel).first().waitFor({ state: 'visible' });
  const projects = await s.page.evaluate((sel) => {
    const seen = new Map();
    for (const a of Array.from(document.querySelectorAll(sel))) {
      const href = a.getAttribute('href');
      if (!href) continue;
      const m = href.match(/\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/);
      if (!m) continue;
      const id = m[1];
      const title = a.textContent.trim();
      if (!seen.has(id) && title) seen.set(id, title);
    }
    return Array.from(seen.entries()).map(([id, title]) => ({ id, title }));
  }, anchorSel);
  console.log(`[download_all] dashboard projects found: ${projects.length}`);

  const results = [];
  for (const proj of projects) {
    const url = `https://www.overleaf.com/project/${proj.id}/download/zip`;
    let bytes = 0;
    let ok = false;
    try {
      const resp = await s.ctx.request.get(url, { timeout: 60000 });
      if (resp.ok()) {
        const buf = await resp.body();
        bytes = buf.length;
        writeFileSync(`${OUT_DIR}/${proj.id}.zip`, buf);
        ok = true;
      } else {
        console.error(`[download_all] ${proj.id} download HTTP ${resp.status()}`);
      }
    } catch (e) {
      console.error(`[download_all] ${proj.id} download error: ${e && e.message ? e.message : e}`);
    }
    results.push({ ...proj, bytes, ok });
    console.log(`PROJECT ${JSON.stringify({ id: proj.id, title: proj.title, bytes, ok })}`);
  }

  writeFileSync(`${OUT_DIR}/_index.json`, JSON.stringify(results, null, 2));
  const good = results.filter((r) => r.ok).length;
  console.log(`\n[download_all] OK — downloaded ${good}/${results.length} project sources into ${OUT_DIR}`);
  console.log(`[download_all] index: ${OUT_DIR}/_index.json`);
  await s.close();
  process.exit(0);
} catch (err) {
  console.error('[download_all] unhandled error:', err && err.message ? err.message : err);
  const dp = await shot(s, 'exception');
  console.error(`[download_all] DOM dump: ${dp}`);
  await s.close();
  process.exit(2);
}
