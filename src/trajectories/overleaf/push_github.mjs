// overleaf/push_github.mjs — FULLY AUTOMATED: push the Overleaf project's
// current state UP to its linked GitHub repo. Push-direction sibling of
// pull_github.mjs; reuses its exact proven Google-SSO + project-open +
// openGithubPanel scaffold and only changes the modal action: it clicks
// "Push Overleaf changes to GitHub", fills the commit-message dialog, and
// clicks "Sync". Non-destructive to the Overleaf source.
//
// Usage:
//   node src/trajectories/overleaf/push_github.mjs <PROJECT> <REPO_SLUG>
//   PROJECT   = 24-hex Overleaf project id OR title substring (argv[2]).
//   REPO_SLUG = owner/name of the linked GitHub repo (argv[3]) — the
//               disambiguator: only the project whose GitHub panel names
//               this repo is acted on.
// Env: HEADLESS=1 headless. Exit: 0 pushed · 1 creds/SSO/args · 2 UI step.

import { WSession } from '../../../dist/session/wsession.js';
import { getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { overleafGoogleSignIn } from '../_shared/services/overleaf_google_sign_in.mjs';
import { pageCondition } from '../_shared/page/settled.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';
import { mkdirSync, writeFileSync } from 'node:fs';

let PROJECT = process.argv[2];
if (!PROJECT) PROJECT = process.env.OVERLEAF_PROJECT;
let REPO_SLUG = process.argv[3];
if (!REPO_SLUG) REPO_SLUG = process.env.OVERLEAF_GITHUB_REPO;
if (!PROJECT || !REPO_SLUG) {
  console.error('FAIL: need <PROJECT> <REPO_SLUG>. PROJECT=24-hex id or title substring; REPO_SLUG=owner/name of the linked GitHub repo (the disambiguator).');
  process.exit(1);
}
const IS_ID = /^[0-9a-fA-F]{24}$/.test(PROJECT);
const REPO_LC = REPO_SLUG.toLowerCase();

const SHOT_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/push_github`;
mkdirSync(SHOT_DIR, { recursive: true });
let shotN = 0;
async function shot(s, tag) {
  shotN += 1;
  // DOM dump, NOT page.screenshot. page.screenshot() hangs ~30s on the
  // Overleaf editor SPA: it waits for fonts/stability the editor never
  // reaches (continuous PDF compile + CodeMirror + websockets), observed
  // as a 30s timeout that aborts the run. page.content() serializes the
  // current DOM immediately without that wait, and is a *better*
  // diagnostic for locating the exact selector when a step misses.
  const p = `${SHOT_DIR}/${String(shotN).padStart(2, '0')}_${tag}.html`;
  const html = await s.page.content();
  writeFileSync(p, html);
  console.log(`[pull_github] [${tag}] DOM ${p} (${html.length}b)`);
  return p;
}
async function dieUI(s, tag, msg) {
  console.error(`\n[pull_github] STEP FAILED: ${tag} — ${msg}`);
  const p = await shot(s, `fail_${tag}`);
  console.error(`[pull_github] FAIL (exit 2). Inspect ${p} to correct the exact selector — do not guess.`);
  await s.close();
  process.exit(2);
}

const login = await getGoogleSsoCreds();
if (!login) {
  console.error('FAIL: exact weles-google-sso-login grant unavailable.');
  process.exit(1);
}
console.log(`[pull_github] Google creds loaded for ${login.email}; target repo ${REPO_SLUG}`);

const s = await WSession.start({
  label: 'push_github',
  browser: 'chromium',
  headful: process.env.HEADLESS !== '1',
});

// Open the editor menu and the GitHub sync panel for the currently-open
// project. Returns the GitHub-panel visible text so the caller can decide
// whether this project is the one linked to REPO_SLUG.
// Overleaf's new IDE-redesign: GitHub sync is NOT in the File menu (the
// captured 02_file_menu.html has only New file/folder, Upload, Make a
// copy, Show version history, Word count, Submit, Download, Settings).
// It lives in the left-rail "Integrations" panel —
// #ide-rail-tabs-tab-integrations is the concrete stable id observed in
// the captured editor DOM (03_exception.html), not a guess. Open it,
// DOM-dump it (evidence), then if a further "GitHub" control is present
// inside the panel, click it to reveal the linked-repo info + pull
// action. The repo-link decision uses the panel innerText.
async function openGithubPanel(s) {
  const integrationsTab = s.page.locator('#ide-rail-tabs-tab-integrations');
  await integrationsTab.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, integrationsTab);
  await humanIdlePause('short');
  await shot(s, 'integrations');
  // The integrations panel may list "GitHub" as an expandable entry. If a
  // GitHub control is present, click it to surface the linked repo + the
  // pull action. Its absence is fine — innerText still drives the
  // decision and a DOM dump is on record either way.
  const ghEntry = s.page.locator(
    '#ide-rail-tabs-tabpane-integrations :is(button,a):has-text("GitHub")'
  ).filter({ visible: true }).first();
  if (await ghEntry.count() > 0) {
    await humanClickLocator(s.page, ghEntry);
    await humanIdlePause('short');
    await shot(s, 'github_detail');
    // Clicking the GitHub card opens the "Sync with GitHub" modal, which
    // first renders "Checking project status in GitHub" while it queries
    // GitHub asynchronously, THEN renders the linked repo + pull action.
    // Reading innerText during the checking state yields a false "not
    // linked" (proven by the captured 04_github_6755b68d.html). Wait for
    // the modal, then for the checking-status text to go.
    const modalTitle = s.page.locator('.modal-title:has-text("Sync with GitHub")').first();
    await modalTitle.waitFor({ state: 'visible' });
    await s.page.getByText('Checking project status in GitHub').first().waitFor({ state: 'hidden' });
    await humanIdlePause('short');
    await shot(s, 'github_modal_loaded');
  }
  const txt = await s.page.evaluate(() => document.body.innerText);
  return txt;
}

try {
  const signedIn = await overleafGoogleSignIn(s, login, { label: 'push_github' });
  if (!signedIn.alreadySignedIn && !/\/project(\?|$|\/)/.test(signedIn.url)) {
    await s.goto('https://www.overleaf.com/project');
  }

  // Build the candidate list.
  let candidates = [];
  if (IS_ID) {
    candidates = [{ id: PROJECT, name: '(by id)' }];
  } else {
    const anchorSel = 'a[href*="/project/"]';
    await s.page.locator(anchorSel).first().waitFor({ state: 'visible' });
    candidates = await s.page.evaluate(({ sel, needle }) => {
      const want = needle.toLowerCase();
      const seen = new Map();
      for (const a of Array.from(document.querySelectorAll(sel))) {
        const hrefAttr = a.getAttribute('href');
        if (hrefAttr === null) continue;
        const m = hrefAttr.match(/\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/);
        if (!m) continue;
        const id = m[1];
        const name = a.textContent.trim();
        if (!seen.has(id)) seen.set(id, name);
      }
      const out = [];
      for (const [id, name] of seen.entries()) {
        if (name.toLowerCase().includes(want)) out.push({ id, name });
      }
      return out;
    }, { sel: anchorSel, needle: PROJECT });
    if (candidates.length === 0) {
      await dieUI(s, 'resolve', `no dashboard project title contains "${PROJECT}"`);
    }
    console.log(`[pull_github] ${candidates.length} title match(es); disambiguating by GitHub link to ${REPO_SLUG}`);
  }

  // For each candidate, open its GitHub panel and act ONLY on the project
  // whose linked repository is REPO_SLUG.
  const report = [];
  let pulled = false;
  for (const c of candidates) {
    const tag8 = c.id.slice(0, 8);
    await s.goto(`https://www.overleaf.com/project/${c.id}`);
    await humanIdlePause('deliberate');
    if (!s.page.url().includes(`/project/${c.id}`)) {
      report.push(`${c.id} (${c.name}): did not open (at ${s.page.url()})`);
      continue;
    }
    await shot(s, `editor_${tag8}`);
    const panelText = await openGithubPanel(s);
    await shot(s, `github_${tag8}`);
    if (panelText.toLowerCase().includes(REPO_LC)) {
      console.log(`[pull_github] MATCH — project ${c.id} (${c.name}) is linked to ${REPO_SLUG}`);
      const pushBtn = s.page.getByRole('button', { name: /push overleaf changes to github/i })
        .or(s.page.getByText(/push overleaf changes to github/i))
        .filter({ visible: true }).first();
      await pushBtn.waitFor({ state: 'visible' });
      await humanClickLocator(s.page, pushBtn);
      await humanIdlePause('deliberate');
      // The push button opens a commit dialog (message textarea + green Sync);
      // the push does NOT run until Sync is clicked (frame_672c66b9_060.png).
      const msgBox = s.page.getByPlaceholder(/commit message for changes made in overleaf/i)
        .or(s.page.locator('.modal-dialog textarea')).filter({ visible: true }).first();
      await msgBox.waitFor({ state: 'visible' });
      await humanFill(s.page, msgBox, process.env.OVERLEAF_COMMIT_MESSAGE || 'Sync Overleaf edits to GitHub');
      await shot(s, `commit_dialog_${tag8}`);
      const syncBtn = s.page.getByRole('button', { name: /^\s*sync\s*$/i }).filter({ visible: true }).first();
      await syncBtn.waitFor({ state: 'visible' });
      await humanClickLocator(s.page, syncBtn);
      await humanIdlePause('deliberate');
      // Self-verify the push. Overleaf commits the project's current state to
      // GitHub then settles on either a success/up-to-date state or surfaces a
      // conflict/error. Wait until the page leaves the in-progress state;
      // HARD FAIL on any conflict/error so success is never claimed silently.
      const outcome = await pageCondition(s.page, () => {
        const low = (document.body?.innerText || '').toLowerCase();
        if (/merge conflict|could not be (?:automatically )?merged|failed to (?:push|merge|sync)|push failed|unable to (?:push|merge)/.test(low)) return 'conflict';
        if (!/checking project status in github|pushing changes to github|importing and merging changes in github/.test(low)) return 'settled';
        return false;
      });
      if (outcome === 'conflict') {
        await dieUI(s, `push_conflict_${tag8}`, `Overleaf reported a conflict/error pushing ${c.id} to ${REPO_SLUG}`);
      }
      const fin = await shot(s, `after_push_${tag8}`);
      console.log(`\n[push_github] OK — pushed Overleaf changes (${c.id}) to GitHub (${REPO_SLUG}); result settled with no conflict/error.`);
      console.log(`[push_github] final URL: ${s.page.url()}`);
      console.log(`[push_github] post-push DOM: ${fin}`);
      pulled = true;
      break;
    }
    report.push(`${c.id} (${c.name}): GitHub panel does not name ${REPO_SLUG}`);
  }

  if (!pulled) {
    console.error('[pull_github] no matched project is linked to the target repo:');
    for (const r of report) console.error(`  ${r}`);
    await dieUI(s, 'nolink', `none of ${candidates.length} candidate(s) had GitHub link ${REPO_SLUG}`);
  }
  await s.close();
  process.exit(0);
} catch (err) {
  console.error('[pull_github] unhandled error:', err && err.message ? err.message : err);
  const dp = await shot(s, 'exception');
  console.error(`[pull_github] DOM dump (find the exact selector here): ${dp}`);
  await s.close();
  process.exit(2);
}
