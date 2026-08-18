// overleaf/pull_github.mjs — FULLY AUTOMATED: pull GitHub changes into the
// Overleaf project that is linked to a specific GitHub repo. No human
// step, no keeper, no manual login, no guessing between same-named
// projects — the GitHub integration itself is the disambiguator.
//
// Evidence basis: .work/list_auto/overleaf_list_auto_failure.png shows the
// automated Google-SSO flow reaching a fully authenticated Overleaf
// dashboard. The automated SSO works end to end; this trajectory reuses
// that exact proven auth path, then for every project whose title matches
// PROJECT it opens the GitHub sync panel and pulls ONLY on the one whose
// linked repository is REPO_SLUG.
//
// Usage:
//   node scripts/trajectories/overleaf/pull_github.mjs <PROJECT> <REPO_SLUG>
//   PROJECT   = 24-hex Overleaf project id OR a case-insensitive title
//               substring (argv[2] / OVERLEAF_PROJECT).
//   REPO_SLUG = owner/name of the GitHub repo the right project is synced
//               to, e.g. lbartoszcze/largelanguagemodels (argv[3] /
//               OVERLEAF_GITHUB_REPO). This is the disambiguator: the only
//               project acted on is the one whose GitHub panel names this
//               repo. A non-unique title is resolved by it, not guessed.
//
// Env: HEADLESS=1 headless (default visible — Google heuristics, as list_auto).
//
// Exit codes:
//   0 success — pulled on the project linked to REPO_SLUG
//   1 no creds / SSO did not complete / bad args / no title match
//   2 a UI step failed, or NO matched project is linked to REPO_SLUG —
//     screenshots in .work/pull_github/ show the exact state (no recovery
//     shortcuts, nothing skipped)

import { WSession } from '../../../dist/session/wsession.js';
import { SessionStore } from '../../../dist/session/store.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
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

const SHOT_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/pull_github`;
mkdirSync(SHOT_DIR, { recursive: true });
const OVERLEAF_AUTH_LABEL = process.env.OVERLEAF_AUTH_LABEL || 'overleaf';
const OVERLEAF_PROFILE_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/overleaf_browser_profile`;
if (process.env.WELES_OVERLEAF_PERSISTENT_PROFILE !== '0' && !process.env.WELES_USER_DATA_DIR) {
  mkdirSync(OVERLEAF_PROFILE_DIR, { recursive: true });
  process.env.WELES_USER_DATA_DIR = OVERLEAF_PROFILE_DIR;
  console.log(`[pull_github] using persistent Overleaf browser profile: ${OVERLEAF_PROFILE_DIR}`);
}
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
function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function dieUI(s, tag, msg) {
  console.error(`\n[pull_github] STEP FAILED: ${tag} — ${msg}`);
  const p = await shot(s, `fail_${tag}`);
  console.error(`[pull_github] FAIL (exit 2). Inspect ${p} to correct the exact selector — do not guess.`);
  await s.close();
  process.exit(2);
}
async function captureOverleafAuth(store, s, why) {
  const cookies = await store.capturePlaywright(s.ctx, OVERLEAF_AUTH_LABEL);
  const overleafCookies = cookies.filter((c) => String(c.domain || '').includes('overleaf.com')).length;
  console.log(`[pull_github] captured ${overleafCookies}/${cookies.length} cookies for ${OVERLEAF_AUTH_LABEL} (${why})`);
}
async function findGoogleSsoSurface(s, googleBtn) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    console.log(`[pull_github] clicking Google SSO button (attempt ${attempt})`);
    let popupCaught = null;
    const popupPromise = s.page.waitForEvent('popup').then((p) => { popupCaught = p; return p; }, () => null);
    await humanClickLocator(s.page, googleBtn);
    const popup = await Promise.race([
      popupPromise,
      waitMs(5000),  // allow-raw-playwright: bounded popup detection
    ]);
    if (popup || popupCaught) return { mode: 'popup', page: popup || popupCaught };
    for (let i = 0; i < 40; i += 1) {
      for (const p of s.ctx.pages()) {
        if (p !== s.page && /accounts\.google\.com/.test(p.url())) return { mode: 'popup', page: p };
      }
      if (/accounts\.google\.com/.test(s.page.url())) return { mode: 'main', page: s.page };
      await s.page.waitForTimeout(250);  // allow-raw-playwright: SSO surface poll
    }
    await shot(s, `google_sso_not_opened_${attempt}`);
  }
  return null;
}

const login = await getGoogleSsoCreds();
if (!login) {
  console.error('FAIL: exact weles-google-sso-login grant unavailable.');
  process.exit(Number('1'));
}
console.log(`[pull_github] Google creds loaded for ${login.email}; target repo ${REPO_SLUG}`);

const s = await WSession.start({
  label: 'pull_github',
  browser: 'chromium',
  headful: process.env.HEADLESS !== '1',
});
const sessionStore = new SessionStore();
const injectedCookies = await sessionStore.injectPlaywright(s.ctx, OVERLEAF_AUTH_LABEL).catch((e) => {
  console.log(`[pull_github] auth-cookie inject failed: ${e.message}`);
  return false;
});
if (injectedCookies) console.log(`[pull_github] injected stored cookies for ${OVERLEAF_AUTH_LABEL}`);

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
  const ghEntry = s.page
    .getByText('Sync with a GitHub repository.', { exact: true })
    .locator('xpath=ancestor::button[contains(@class, "integrations-panel-card-button")][1]')
    .or(
      s.page.locator('#ide-rail-tabs-tabpane-integrations button.integrations-panel-card-button', {
        hasText: 'Sync with a GitHub repository.',
      })
    )
    .filter({ visible: true })
    .first();
  let clickedGithubEntry = false;
  if (await ghEntry.count() > 0) {
    await humanClickLocator(s.page, ghEntry);
    clickedGithubEntry = true;
  } else {
    clickedGithubEntry = await s.page.evaluate(() => {
      const pane = document.querySelector('#ide-rail-tabs-tabpane-integrations');
      if (!pane) return false;
      const buttons = Array.from(pane.querySelectorAll('button'));
      const btn = buttons.find((b) => {
        const txt = b.innerText || '';
        return txt.includes('GitHub') && txt.includes('Sync with a GitHub repository');
      });
      if (!btn) return false;
      btn.click();
      return true;
    });
  }
  if (clickedGithubEntry) {
    await humanIdlePause('short');
    await shot(s, 'github_detail');
    // Clicking the GitHub card opens the "Sync with GitHub" modal, which
    // first renders "Checking project status in GitHub" while it queries
    // GitHub asynchronously, THEN renders the linked repo + pull action.
    // Reading innerText during the checking state yields a false "not
    // linked" (proven by the captured 04_github_6755b68d.html). Wait for
    // the modal, then poll until the checking-status text clears.
    const modalTitle = s.page.locator('.modal-title:has-text("Sync with GitHub")').first();
    await modalTitle.waitFor({ state: 'visible' });
    for (let i = 0; i < 40; i += 1) {
      const checking = await s.page.getByText('Checking project status in GitHub').count();
      if (checking === 0) break;
      await s.page.waitForTimeout(500);  // allow-raw-playwright: async GitHub-status poll
    }
    await humanIdlePause('short');
    await shot(s, 'github_modal_loaded');
  }
  const txt = await s.page.evaluate(() => document.body.innerText);
  return txt;
}

try {
  await s.goto('https://www.overleaf.com/login');
  await humanIdlePause('short');

  if (/\/project(\?|$|\/)/.test(s.page.url())) {
    console.log('[pull_github] already authenticated via persisted cookies');
    await captureOverleafAuth(sessionStore, s, 'already-authenticated');
  } else {
    const cookieBtn = s.page.getByRole('button', { name: /essential cookies only|accept all cookies/i }).first();
    if (await cookieBtn.count() > 0) {
      console.log('[pull_github] dismissing cookie banner');
      await humanClickLocator(s.page, cookieBtn);
      await s.page.waitForTimeout(500);  // allow-raw-playwright: cookie-banner settle
    }
    const googleBtn = s.page.getByRole('button', { name: /log in with google|sign in with google/i }).or(
      s.page.getByRole('link', { name: /log in with google|sign in with google/i })
    ).first();
    await googleBtn.waitFor({ state: 'visible' });
    const surface = await findGoogleSsoSurface(s, googleBtn);
    if (!surface) {
      await dieUI(s, 'google_sso_surface', 'clicking the Google login button did not open accounts.google.com in the main page or a popup');
    }

    if (surface.mode === 'popup') {
      console.log('[pull_github] Google SSO in popup');
      await surface.page.waitForLoadState('domcontentloaded');
      const ok = await googleSso(s, login, { originHost: 'overleaf.com', page: surface.page });
      if (!ok) { console.error('FAIL: Google SSO did not complete (popup)'); await s.close(); process.exit(1); }
    } else {
      console.log('[pull_github] Google SSO in-place redirect');
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
    let finalUrl = settledUrl;
    if (finalUrl === null) finalUrl = s.page.url();
    console.log(`[pull_github] settled URL: ${finalUrl}`);
    if (/\/login(\?|$|\/)/.test(finalUrl)) {
      await dieUI(s, 'sso', `Overleaf returned to /login after SSO (auth not established) — ${finalUrl}`);
    }
    if (!/\/project(\?|$|\/)/.test(finalUrl)) {
      await s.goto('https://www.overleaf.com/project');
    }
    await captureOverleafAuth(sessionStore, s, 'post-sso');
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
    const hasManualMergeContinue = await s.page
      .getByRole('button', { name: /i have manually merged\.?\s*continue/i })
      .filter({ visible: true })
      .count() > 0;
    if (panelText.toLowerCase().includes(REPO_LC) || (IS_ID && hasManualMergeContinue)) {
      console.log(`[pull_github] MATCH — project ${c.id} (${c.name}) is linked to ${REPO_SLUG}`);
      const panelLow = panelText.toLowerCase();
      const manualMergeBtn = s.page.getByRole('button', { name: /i have manually merged\.?\s*continue/i })
        .filter({ visible: true }).first();
      if (await manualMergeBtn.count() > 0) {
        await humanClickLocator(s.page, manualMergeBtn);
        await humanIdlePause('deliberate');
        let resultText = '';
        let settled = false;
        for (let i = 0; i < 90; i += 1) {
          await s.page.waitForTimeout(1000);  // allow-raw-playwright: post-merge-continue settle poll
          resultText = await s.page.evaluate(() => document.body.innerText);
          const low = resultText.toLowerCase();
          if (/merge conflict|could not be (?:automatically )?merged|failed to (?:pull|merge|sync)|merge failed|unable to merge/.test(low)) {
            await dieUI(s, `merge_continue_conflict_${tag8}`, `Overleaf still reports a conflict/error after manual-merge continue for ${REPO_SLUG} in ${c.id}`);
          }
          if (!/checking project status in github|importing and merging changes in github|i have manually merged/.test(low)) {
            settled = true;
            break;
          }
        }
        const fin = await shot(s, `after_merge_continue_${tag8}`);
        if (!settled) {
          await dieUI(s, `merge_continue_unsettled_${tag8}`, `manual-merge continue did not settle for ${c.id}`);
        }
        console.log(`\n[pull_github] OK — completed manual-merge continuation for ${REPO_SLUG} in ${c.id}.`);
        console.log(`[pull_github] final URL: ${s.page.url()}`);
        console.log(`[pull_github] post-continue DOM: ${fin}`);
        await captureOverleafAuth(sessionStore, s, 'post-merge-continue');
        pulled = true;
        break;
      }
      if (/no new commits in github since last merge|already up[ -]?to[ -]?date|up to date/.test(panelLow)) {
        const fin = await shot(s, `up_to_date_${tag8}`);
        console.log(`\n[pull_github] OK — ${REPO_SLUG} is already up to date in ${c.id}.`);
        console.log(`[pull_github] final URL: ${s.page.url()}`);
        console.log(`[pull_github] up-to-date DOM: ${fin}`);
        await captureOverleafAuth(sessionStore, s, 'up-to-date');
        pulled = true;
        break;
      }
      const pullBtn = s.page.getByRole('button', { name: /pull github changes/i })
        .or(s.page.getByText(/pull github changes/i))
        .filter({ visible: true }).first();
      await pullBtn.waitFor({ state: 'visible' });
      await humanClickLocator(s.page, pullBtn);
      await humanIdlePause('deliberate');
      // Self-verify the pull. Overleaf performs the merge then settles on
      // either a success/up-to-date state or surfaces a conflict/error.
      // Poll the page text until it leaves the in-progress state; HARD
      // FAIL on any conflict/error so success is never claimed silently.
      let resultText = '';
      let settled = false;
      for (let i = 0; i < 90; i += 1) {
        await s.page.waitForTimeout(1000);  // allow-raw-playwright: post-pull settle poll
        resultText = await s.page.evaluate(() => document.body.innerText);
        const low = resultText.toLowerCase();
        if (/merge conflict|could not be (?:automatically )?merged|failed to (?:pull|merge|sync)|merge failed|unable to merge/.test(low)) {
          await dieUI(s, `pull_conflict_${tag8}`, `Overleaf reported a conflict/error pulling ${REPO_SLUG} into ${c.id}`);
        }
        if (!/checking project status in github|importing and merging changes in github/.test(low)) {
          settled = true;
          break;
        }
      }
      const fin = await shot(s, `after_pull_${tag8}`);
      if (!settled) {
        await dieUI(s, `pull_unsettled_${tag8}`, `pull did not settle for ${c.id} (still in progress after poll)`);
      }
      console.log(`\n[pull_github] OK — pulled GitHub changes (${REPO_SLUG}) into ${c.id}; result settled with no conflict/error.`);
      console.log(`[pull_github] final URL: ${s.page.url()}`);
      console.log(`[pull_github] post-pull DOM: ${fin}`);
      await captureOverleafAuth(sessionStore, s, 'post-pull');
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
