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
//   node src/trajectories/overleaf/pull_github.mjs <PROJECT> <REPO_SLUG>
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
//     DOM dumps beside the run's recordings show the exact state (no
//     recovery shortcuts, nothing skipped)

import { WSession } from '../../../dist/session/wsession.js';
import { SessionStore } from '../../../dist/session/store.js';
import { getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { IS_ID, OVERLEAF_AUTH_LABEL, REPO_LC, REPO_SLUG } from './pull_github/settings.mjs';
import { captureOverleafAuth, dieUI, shot } from './pull_github/evidence.mjs';
import { signInToOverleaf } from './pull_github/sign_in.mjs';
import { openGithubPanel } from './pull_github/github_panel.mjs';
import { resolveCandidates } from './pull_github/resolve.mjs';

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

try {
  await signInToOverleaf(s, sessionStore, login);
  const candidates = await resolveCandidates(s);

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
