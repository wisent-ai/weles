// overleaf/io/download_all.mjs — inventory + source download for EVERY Overleaf
// project, reusing pull_github.mjs's PROVEN Google-SSO + dashboard scaffold.
// After auth it scrapes the dashboard for all {id,title} then downloads each
// project's source via the authenticated zip endpoint
// (/project/<id>/download/zip) using the context request (shares cookies),
// saving to .work/ol_sources/<id>.zip. Prints a JSON line per project so the
// caller gets the full id->title map for reconciliation against GitHub repos.
//
// Usage: node src/trajectories/overleaf/io/download_all.mjs
// Env: HEADLESS=1 headless (default visible).
// Exit: 0 all projects attempted; 1 no creds / SSO failed; 2 a UI step failed.

import { WSession } from '../../../../dist/session/wsession.js';
import { getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { overleafGoogleSignIn } from '../../_shared/services/overleaf_google_sign_in.mjs';
import { humanIdlePause } from '../../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

// Sources land where the caller says; nothing under one person's home is assumed.
const OUT_DIR = process.env.OVERLEAF_SOURCES_DIR;
if (!OUT_DIR) {
  console.error(
    'FAIL: OVERLEAF_SOURCES_DIR env var required: the directory the project zips are written to',
  );
  process.exit(1);
}
const SHOT_DIR = runRecordingsDir('overleaf_download_all');
mkdirSync(OUT_DIR, { recursive: true });
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
if (!login) {
  console.error('FAIL: getGoogleSsoCreds() returned null.');
  process.exit(1);
}
console.log(`[download_all] Google creds loaded for ${login.email}`);

const s = await WSession.start({
  label: 'download_all',
  browser: 'chromium',
  headful: process.env.HEADLESS !== '1',
});

try {
  await overleafGoogleSignIn(s, login, { label: 'download_all' });

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
      const resp = await s.ctx.request.get(url);
      if (resp.ok()) {
        const buf = await resp.body();
        bytes = buf.length;
        writeFileSync(`${OUT_DIR}/${proj.id}.zip`, buf);
        ok = true;
      } else {
        console.error(
          `[download_all] ${proj.id} download HTTP ${resp.status()}`,
        );
      }
    } catch (e) {
      console.error(
        `[download_all] ${proj.id} download error: ${e && e.message ? e.message : e}`,
      );
    }
    results.push({ ...proj, bytes, ok });
    console.log(
      `PROJECT ${JSON.stringify({ id: proj.id, title: proj.title, bytes, ok })}`,
    );
  }

  writeFileSync(`${OUT_DIR}/_index.json`, JSON.stringify(results, null, 2));
  const good = results.filter((r) => r.ok).length;
  console.log(
    `\n[download_all] OK — downloaded ${good}/${results.length} project sources into ${OUT_DIR}`,
  );
  console.log(`[download_all] index: ${OUT_DIR}/_index.json`);
  await s.close();
  process.exit(0);
} catch (err) {
  console.error(
    '[download_all] unhandled error:',
    err && err.message ? err.message : err,
  );
  const dp = await shot(s, 'exception');
  console.error(`[download_all] DOM dump: ${dp}`);
  await s.close();
  process.exit(2);
}
