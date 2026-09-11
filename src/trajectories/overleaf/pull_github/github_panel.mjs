// Opening the GitHub sync panel of the currently open project.
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { shot } from './evidence.mjs';

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
export async function openGithubPanel(s) {
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
    const fallback = s.page.locator('#ide-rail-tabs-tabpane-integrations button')
      .filter({ hasText: /GitHub[\s\S]*Sync with a GitHub repository|Sync with a GitHub repository[\s\S]*GitHub/ })
      .filter({ visible: true }).first();
    clickedGithubEntry = await fallback.count() > 0;
    if (clickedGithubEntry) await humanClickLocator(s.page, fallback);
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
