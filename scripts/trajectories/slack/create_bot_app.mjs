// Step 2b of the slack-post trajectory, extracted to keep post_message.mjs
// under the 300-line file cap. Drives api.slack.com/apps?new_app=1 → From
// a manifest (via Tab+Enter keyboard nav — more reliable than DOM clicks
// across browser personas) → workspace pick → paste manifest → install +
// authorize → scrape xoxb- from OAuth & Permissions page.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Returns the xoxb- bot token (empty string on any failure). */
export async function createBotApp({ page, weles, shot }) {
  const { humanFill } = await import(`${weles}/dist/human/keyboard.js`);
  const { humanClickLocator, humanIdlePause } = await import(`${weles}/dist/human/mouse.js`);

  await page.goto('https://wisent-workspace.slack.com/apps/manage', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await page.goto('https://api.slack.com/apps?new_app=1', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await shot('07-new-app-dialog');

  // From a manifest — verified by DOM dump to be a <button class="c-button-unstyled">.
  const fmBtn = page.locator('button.c-button-unstyled').filter({
    hasText: /from a manifest/i,
  }).first();
  await fmBtn.waitFor({ state: 'visible' });
  console.log('[bot] clicking <button class="c-button-unstyled">From a manifest</button>');
  await humanClickLocator(page, fmBtn, { timeoutMs: 10000 });
  await page.waitForLoadState('domcontentloaded');
  await humanIdlePause('long');
  await shot('07b-after-from-manifest');

  // Workspace picker: <button id="team-picker_button" class="c-select_button">
  // with text "Select a team" (NOT "Select a workspace" — that's the heading).
  await humanIdlePause('long');
  const trigger = page.locator('#team-picker_button, button.c-select_button').first();
  await trigger.waitFor({ state: 'visible' });
  await humanClickLocator(page, trigger, { timeoutMs: 10000 });
  await humanIdlePause('short');
  const wisOpt = page.getByRole('option', { name: /wisent/i })
    .or(page.locator('[role="menuitem"]').filter({ hasText: /wisent/i }))
    .or(page.locator('li, a, button').filter({ hasText: /^\s*Wisent\s*$/i }))
    .first();
  await wisOpt.waitFor({ state: 'visible' });
  const wisLabel = await wisOpt.textContent();
  console.log(`[bot] picking workspace "${(wisLabel || '').slice(0, 60)}"`);
  await humanClickLocator(page, wisOpt, { timeoutMs: 10000 });
  await humanIdlePause('short');
  await humanClickLocator(page, page.getByRole('button', { name: /^next$/i }).first(), { timeoutMs: 10000 });
  await humanIdlePause('long');

  const manifest = readFileSync(join(__dirname, 'manifest.yaml'), 'utf8');
  spawnSync('/usr/bin/pbcopy', [], { input: manifest });
  await shot('07d-manifest-editor');
  // Switch to YAML tab since our manifest is YAML.
  const yamlTab = page.getByRole('tab', { name: /^YAML$/i })
    .or(page.locator('button, a').filter({ hasText: /^YAML$/i })).first();
  if (await yamlTab.count() > 0) {
    console.log('[bot] switching to YAML tab');
    await humanClickLocator(page, yamlTab, { timeoutMs: 10000 });
    await humanIdlePause('short');
  }
  // Editor is a code-mirror style overlay over a hidden <textarea>.
  // Force-click so keyboard events route to it.
  const ta = page.locator('textarea').first();
  await ta.click({ force: true });
  await humanIdlePause('short');
  await humanIdlePause('short');
  await page.keyboard.press('Meta+A');
  await page.keyboard.press('Backspace');
  await humanIdlePause('short');
  await page.keyboard.press('Meta+V');
  await humanIdlePause('deliberate');
  await shot('08-manifest-pasted');
  await humanClickLocator(page, page.getByRole('button', { name: /^next$/i }).first(), { timeoutMs: 10000 });
  await humanIdlePause('deliberate');
  await humanClickLocator(page, page.getByRole('button', { name: /^create$/i }).first(), { timeoutMs: 10000 });
  await page.waitForLoadState('domcontentloaded');
  await humanIdlePause('long');

  await humanClickLocator(page, page.getByRole('button', { name: /install to workspace/i }).first(), { timeoutMs: 15000 });
  await page.waitForLoadState('domcontentloaded');
  await humanIdlePause('deliberate');
  await humanClickLocator(page, page.getByRole('button', { name: /^allow$/i }).first(), { timeoutMs: 15000 });
  await page.waitForLoadState('domcontentloaded');
  await humanIdlePause('long');

  await humanClickLocator(page, page.locator('a[href*="/oauth"]').first(), { timeoutMs: 10000 });
  await page.waitForLoadState('domcontentloaded');
  await humanIdlePause('deliberate');
  await shot('11-oauth-page');
  const xoxb = await page.evaluate(() => {
    const m = (document.body.innerText || '').match(/xoxb-\d+-\d+-[A-Za-z0-9]+/);
    return m ? m[0] : '';
  });
  return xoxb || '';
}
