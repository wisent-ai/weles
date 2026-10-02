// overleaf/import_github.mjs — create NEW Overleaf projects by importing one or
// more GitHub repos (e.g. wisent-ai/<name>), reusing pull_github.mjs's PROVEN
// Google-SSO + dashboard scaffold. Logs in ONCE, then imports every repo slug
// passed on argv in the same session: New Project -> Import from GitHub -> find
// the repo in the (full, in-DOM) list -> click "Import to Overleaf" -> capture
// the new /project/<id>. Per-repo failures are recorded and the batch
// continues; each step DOM-dumps via page.content().
//
// Usage:
//   node src/trajectories/overleaf/import_github.mjs <slug> [<slug> ...]
//   slug = owner/name, e.g. wisent-ai/wisent-welfare
//
// Exit codes: 0 all imported; 1 no creds / SSO failed / bad args; 2 >=1 repo
//   failed (the others still imported) — see the per-repo summary + DOM dumps.

import { WSession } from '../../../../dist/session/wsession.js';
import { getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { overleafGoogleSignIn } from '../../_shared/services/overleaf_google_sign_in.mjs';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { humanIdlePause, humanClickLocator } from '../../../../dist/human/mouse.js';
import { writeFileSync } from 'node:fs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

let REPO_SLUGS = process.argv.slice(2);
if (REPO_SLUGS.length === 0 && process.env.OVERLEAF_GITHUB_REPO) REPO_SLUGS = [process.env.OVERLEAF_GITHUB_REPO];
REPO_SLUGS = REPO_SLUGS.filter((r) => /^[^/]+\/[^/]+$/.test(r));
if (REPO_SLUGS.length === 0) {
  console.error('FAIL: need one or more <slug> as owner/name, e.g. wisent-ai/wisent-welfare');
  process.exit(1);
}

const SHOT_DIR = runRecordingsDir('overleaf_import_github');
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
  process.exit(1);
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
  // search box). Wait for its import buttons to render and the list to
  // settle, then look for the slug/name.
  await s.page.getByRole('button', { name: /import to overleaf/i }).first().waitFor({ state: 'visible' });
  await pageSettled(s.page);
  const pickerText = (await s.page.evaluate(() => document.body.innerText)).toLowerCase();
  if (!pickerText.includes(REPO_LC) && !pickerText.includes(REPO_NAME.toLowerCase())) {
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

  // Overleaf either lands on the new /project/<id> or asks to confirm first;
  // each confirmation is answered until the project opens.
  const onProject = /\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/;
  const confirm = s.page.getByRole('button', { name: /^(import|create|continue|confirm)$/i }).filter({ visible: true }).first();
  while (!onProject.test(s.page.url())) {
    const next = await Promise.any([
      s.page.waitForURL(onProject).then(() => 'project'),
      confirm.waitFor({ state: 'visible' }).then(() => 'confirm'),
    ]);
    if (next === 'confirm') await humanClickLocator(s.page, confirm);
  }
  const projectId = s.page.url().match(onProject)[1];
  await shot(s, `done_${tag}`);
  return projectId;
}

try {
  await overleafGoogleSignIn(s, login, { label: 'import_github' });

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
