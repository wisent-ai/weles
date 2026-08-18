// overleaf/import_github.mjs — create NEW Overleaf projects by importing one or
// more GitHub repos (e.g. wisent-ai/<name>), reusing pull_github.mjs's PROVEN
// Google-SSO + dashboard scaffold. Logs in ONCE, then imports every repo slug
// passed on argv in the same session: New Project -> Import from GitHub -> find
// the repo in the (full, in-DOM) list -> click "Import to Overleaf" -> capture
// the new /project/<id>. Per-repo failures are recorded and the batch
// continues; each step DOM-dumps via page.content().
//
// Usage:
//   node scripts/trajectories/overleaf/import_github.mjs <slug> [<slug> ...]
//   slug = owner/name, e.g. wisent-ai/wisent-welfare
//
// Exit codes: 0 all imported; 1 no creds / SSO failed / bad args; 2 >=1 repo
//   failed (the others still imported) — see the per-repo summary + DOM dumps.

import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';

let REPO_SLUGS = process.argv.slice(2);
if (REPO_SLUGS.length === 0 && process.env.OVERLEAF_GITHUB_REPO) REPO_SLUGS = [process.env.OVERLEAF_GITHUB_REPO];
REPO_SLUGS = REPO_SLUGS.filter((r) => /^[^/]+\/[^/]+$/.test(r));
if (REPO_SLUGS.length === 0) {
  console.error('FAIL: need one or more <slug> as owner/name, e.g. wisent-ai/wisent-welfare');
  process.exit(1);
}

const SHOT_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/import_github`;
mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(s, tag) {
  shotN += 1;
  const p = `${SHOT_DIR}/${String(shotN).padStart(2, '0')}_${tag}.html`;
  const html = await s.page.content();
  writeFileSync(p, html);
  console.log(`[import_github] [${tag}] DOM ${p} (${html.length}b)`);
  return p;
}
async function dieFatal(s, tag, msg) {
  console.error(`\n[import_github] FATAL: ${tag} — ${msg}`);
  await shot(s, `fatal_${tag}`);
  await s.close();
  process.exit(2);
}

const login = await getGoogleSsoCreds();
if (!login) {
  console.error('FAIL: exact weles-google-sso-login grant unavailable.');
  process.exit(Number('1'));
}
console.log(`[import_github] Google creds loaded for ${login.email}; importing ${REPO_SLUGS.length} repo(s)`);

const s = await WSession.start({
  label: 'import_github',
  browser: 'chromium',
  headful: process.env.HEADLESS !== '1',
});

// Import a single repo from the dashboard. Throws on any step failure so the
// caller can record it and continue with the next repo.
async function importOne(slug) {
  const REPO_LC = slug.toLowerCase();
  const REPO_NAME = slug.split('/').pop();
  const OWNER = slug.split('/')[0];
  const tag = REPO_NAME.replace(/[^a-z0-9]/gi, '').slice(0, 14);

  await s.goto('https://www.overleaf.com/project');
  await humanIdlePause('short');

  const newProjBtn = s.page.getByRole('button', { name: /new project/i })
    .or(s.page.getByRole('link', { name: /new project/i }))
    .filter({ visible: true }).first();
  if (await newProjBtn.count() === 0) throw new Error('no "New Project" control on dashboard');
  await humanClickLocator(s.page, newProjBtn);
  await humanIdlePause('short');

  const importItem = s.page.getByRole('menuitem', { name: /import from github/i })
    .or(s.page.getByText(/import from github/i))
    .filter({ visible: true }).first();
  if (await importItem.count() === 0) throw new Error('no "Import from GitHub" menu entry');
  await humanClickLocator(s.page, importItem);
  await humanIdlePause('deliberate');

  // The picker renders the FULL list of accessible repos as DOM rows (no
  // search box). Wait for it to populate, then look for the slug/name.
  let pickerText = '';
  let listed = false;
  for (let i = 0; i < 40; i += 1) {
    await s.page.waitForTimeout(500);  // allow-raw-playwright: repo-list async load
    pickerText = (await s.page.evaluate(() => document.body.innerText)).toLowerCase();
    if (pickerText.includes(REPO_LC) || pickerText.includes(REPO_NAME.toLowerCase())) { listed = true; break; }
    if (pickerText.includes('import to overleaf') && i >= 6) break;
  }
  if (!listed) {
    await shot(s, `absent_${tag}`);
    throw new Error(`not in import picker — Overleaf cannot see owner/org "${OWNER}" (grant OAuth access)`);
  }

  // Scope the Import button to the EXACT repo's row, identified by its GitHub
  // anchor href (github.com/<owner>/<name>). Never click any other row's
  // button: a broad selector previously matched an ancestor container and
  // imported the alphabetically-first repo for every paper. If this exact
  // row's button is missing, fail loudly rather than click the wrong row.
  const hrefFrag = `github.com/${slug}`;
  const row = s.page.locator('tr', { has: s.page.locator(`a[href*="${hrefFrag}"]`) }).first();
  const rowImport = row.getByRole('button', { name: /import to overleaf|^\s*import\s*$/i }).first();
  if (await rowImport.count() === 0) {
    await shot(s, `nobtn_${tag}`);
    throw new Error(`row for ${hrefFrag} found but no Import button inside it`);
  }
  await rowImport.scrollIntoViewIfNeeded();
  await humanClickLocator(s.page, rowImport);
  await humanIdlePause('deliberate');

  let projectId = null;
  for (let i = 0; i < 60; i += 1) {
    await s.page.waitForTimeout(1000);  // allow-raw-playwright: import+create settle
    const m = s.page.url().match(/\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/);
    if (m) { projectId = m[1]; break; }
    const confirm = s.page.getByRole('button', { name: /^(import|create|continue|confirm)$/i }).filter({ visible: true }).first();
    if (await confirm.count() > 0) await humanClickLocator(s.page, confirm);
  }
  if (!projectId) throw new Error('import clicked but never landed on /project/<id>');
  await shot(s, `done_${tag}`);
  return projectId;
}

try {
  await s.goto('https://www.overleaf.com/login');
  await humanIdlePause('short');

  if (/\/project(\?|$|\/)/.test(s.page.url())) {
    console.log('[import_github] already authenticated via persisted cookies');
  } else {
    const cookieBtn = s.page.getByRole('button', { name: /essential cookies only|accept all cookies/i }).first();
    if (await cookieBtn.count() > 0) {
      console.log('[import_github] dismissing cookie banner');
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
      await popup.waitForLoadState('domcontentloaded');
      const ok = await googleSso(s, login, { originHost: 'overleaf.com', page: popup });
      if (!ok) { console.error('FAIL: Google SSO did not complete (popup)'); await s.close(); process.exit(1); }
    } else {
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
    console.log(`[import_github] settled URL: ${finalUrl}`);
    if (/\/login(\?|$|\/)/.test(finalUrl)) {
      await dieFatal(s, 'sso', `Overleaf returned to /login after SSO — ${finalUrl}`);
    }
  }

  const results = [];
  for (const slug of REPO_SLUGS) {
    try {
      const pid = await importOne(slug);
      results.push({ slug, pid, ok: true });
      console.log(`[import_github] IMPORTED ${slug} -> ${pid}`);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      results.push({ slug, ok: false, err: msg });
      console.error(`[import_github] FAILED ${slug}: ${msg}`);
    }
  }

  console.log('\n[import_github] ===== import summary =====');
  for (const r of results) console.log(r.ok ? `  OK    ${r.slug} -> https://www.overleaf.com/project/${r.pid}` : `  FAIL  ${r.slug}: ${r.err}`);
  const good = results.filter((r) => r.ok).length;
  writeFileSync(`${SHOT_DIR}/_import_results.json`, JSON.stringify(results, null, 2));
  console.log(`[import_github] OK — imported ${good}/${results.length} repo(s)`);
  await s.close();
  process.exit(good === results.length ? 0 : 2);
} catch (err) {
  console.error('[import_github] unhandled error:', err && err.message ? err.message : err);
  await shot(s, 'exception');
  await s.close();
  process.exit(2);
}
