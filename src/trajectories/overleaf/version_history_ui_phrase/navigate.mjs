// Getting to the history panel: the Google sign-in through the Overleaf UI, opening the
// project by id or title, and opening the History UI.
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { isId, target } from './settings.mjs';
import { clickText } from './page.mjs';

export async function loginWithGoogleUi(s) {
  await s.goto('https://www.overleaf.com/login');
  await humanIdlePause('short');
  const cookieBtn = s.page.getByRole('button', { name: /essential cookies only|accept all cookies/i }).first();
  if (await cookieBtn.count() > 0) {
    await humanClickLocator(s.page, cookieBtn);
    await s.page.waitForTimeout(500);
  }
  const googleBtn = s.page.getByRole('button', { name: /log in with google|sign in with google/i })
    .or(s.page.getByRole('link', { name: /log in with google|sign in with google/i }))
    .filter({ visible: true })
    .first();
  await googleBtn.waitFor({ state: 'visible', timeout: 15000 });

  let popupCaught = null;
  const popupPromise = s.page.waitForEvent('popup').then((p) => { popupCaught = p; return p; }, () => null);
  await humanClickLocator(s.page, googleBtn);
  const popup = await Promise.race([
    popupPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
  ]);

  let surface = popup || popupCaught;
  if (!surface) {
    for (let i = 0; i < 40; i += 1) {
      for (const p of s.ctx.pages()) {
        if (p !== s.page && /accounts\.google\.com/.test(p.url())) { surface = p; break; }
      }
      if (surface) break;
      if (/accounts\.google\.com/.test(s.page.url())) { surface = s.page; break; }
      await s.page.waitForTimeout(250);
    }
  }
  if (!surface) throw new Error('Google SSO surface did not open');

  const creds = await getGoogleSsoCreds();
  if (!creds) throw new Error('getGoogleSsoCreds() returned null for Overleaf Google SSO');

  const emailInputCount = await surface.locator('input[type="email"], input[name="identifier"], input#identifierId').filter({ visible: true }).count().catch(() => 0);
  if (emailInputCount === 0) {
    const useAnother = surface.getByText(/Use another account/i).filter({ visible: true }).first();
    if (await useAnother.count() > 0) {
      await humanClickLocator(surface, useAnother);
      await humanIdlePause('deliberate');
    }
  }

  const ok = await googleSso(s, creds, { originHost: 'overleaf.com', page: surface });
  if (!ok) throw new Error('Google SSO did not complete');

  for (let i = 0; i < 60; i += 1) {
    await s.page.waitForTimeout(500);
    const url = s.page.url();
    if (/overleaf\.com\/project/.test(url)) return true;
    if (!/accounts\.google\.com|login/.test(url)) {
      await s.goto('https://www.overleaf.com/project');
      return true;
    }
  }
  await s.goto('https://www.overleaf.com/project');
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
  await s.page.locator(anchorSel).first().waitFor({ state: 'visible', timeout: 15000 });
  const anchorLoc = s.page.locator(anchorSel);
  let lastCount = -1;
  for (let i = 0; i < 20; i += 1) {
    const count = await anchorLoc.count();
    if (count > 0) await anchorLoc.nth(count - 1).scrollIntoViewIfNeeded().catch(() => {});
    if (count === lastCount) break;
    lastCount = count;
    await s.page.waitForTimeout(500);
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
    await s.page.waitForTimeout(800);
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
