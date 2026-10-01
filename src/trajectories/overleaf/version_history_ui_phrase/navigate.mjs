// Getting to the history panel: the Google sign-in through the Overleaf UI, opening the
// project by id or title, and opening the History UI.
import { getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { overleafGoogleSignIn } from '../../_shared/services/overleaf_google_sign_in.mjs';
import { pageSettled } from '../../_shared/page/settled.mjs';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { isId, target } from './settings.mjs';
import { clickText } from './page.mjs';

export async function loginWithGoogleUi(s) {
  const creds = await getGoogleSsoCreds();
  if (!creds) throw new Error('getGoogleSsoCreds() returned null for Overleaf Google SSO');
  const signedIn = await overleafGoogleSignIn(s, creds, { label: 'version_history_ui_phrase', chooseAnotherAccount: true });
  if (!/overleaf\.com\/project/.test(signedIn.url)) await s.goto('https://www.overleaf.com/project');
  return true;
}

export async function resolveAndOpenProject(s) {
  if (isId) {
    await s.goto(`https://www.overleaf.com/project/${target}`);
    await humanIdlePause('deliberate');
    return target;
  }

  const needle = target.toLowerCase();
  const anchorSel = 'a[href*="/project/"]';
  await s.page.locator(anchorSel).first().waitFor({ state: 'visible' });
  // The dashboard lazy-loads rows on scroll: scroll to the last row until a
  // settled page shows no more rows than before.
  const anchorLoc = s.page.locator(anchorSel);
  let lastCount = -1;
  for (let count = await anchorLoc.count(); count !== lastCount; count = await anchorLoc.count()) {
    lastCount = count;
    await anchorLoc.nth(count - 1).scrollIntoViewIfNeeded();
    await pageSettled(s.page);
  }

  const match = await s.page.evaluate((needle) => {
    const links = Array.from(document.querySelectorAll('a[href*="/project/"]'));
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      const m = href.match(/\/project\/([0-9a-fA-F]{24})(?:[/?#]|$)/);
      const text = (a.textContent || '').trim();
      if (m && text.toLowerCase().includes(needle)) return { id: m[1], text, href };
    }
    return null;
  }, needle);
  if (!match) throw new Error(`dashboard has no project title containing "${target}"`);

  const link = s.page.locator(`a[href*="/project/${match.id}"]`).first();
  await humanClickLocator(s.page, link);
  await humanIdlePause('deliberate');
  return match.id;
}

export async function openHistoryUi(s) {
  const historyButton = s.page.getByRole('button', { name: /^History$/i }).filter({ visible: true }).first();
  if (await historyButton.count() > 0) {
    await humanClickLocator(s.page, historyButton);
    await humanIdlePause('deliberate');
    return 'toolbar-history-button';
  }

  const menuClick = await clickText(s.page, /^Menu$|^File$/i);
  if (menuClick) {
    await pageSettled(s.page);
    const item = s.page.getByRole('menuitem', { name: /show version history/i }).filter({ visible: true }).first();
    if (await item.count() > 0) {
      await humanClickLocator(s.page, item);
      await humanIdlePause('deliberate');
      return 'file-menu-show-version-history';
    }
    const clicked = await clickText(s.page, /show version history/i);
    if (clicked) {
      await humanIdlePause('deliberate');
      return 'dom-show-version-history';
    }
  }

  const clicked = await clickText(s.page, /^History$|show version history/i);
  if (clicked) {
    await humanIdlePause('deliberate');
    return 'dom-history';
  }
  throw new Error('could not find History / Show version history control');
}
