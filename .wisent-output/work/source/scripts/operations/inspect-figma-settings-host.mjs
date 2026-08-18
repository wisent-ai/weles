#!/usr/bin/env node
import { WSession } from '../../dist/session/wsession.js';

process.env.WELES_SECURE_CREDENTIAL_TASK = '1';
process.env.WELES_NO_INSTRUMENT = '1';
process.env.WELES_DISABLE_RECORDING = '1';
process.env.WELES_PAGE_DIAGNOSTICS = '0';

const session = await WSession.start({
  label: 'figma_settings_inspection',
  targetHost: 'www.figma.com',
  headless: true,
  browser: 'chromium',
  userDataDir: process.env.WELES_USER_DATA_DIR,
});
try {
  await session.goto('https://www.figma.com/settings?tab=security');
  const accountButton = session.page.getByRole('button', { name: /Account dropdown/i }).first();
  if (await accountButton.isVisible().catch(() => false)) {
    await accountButton.click();
    await session.page.waitForTimeout(1000);
  }
  const settingsItem = session.page.getByRole('menuitem', { name: 'Settings', exact: true }).first();
  if (await settingsItem.isVisible().catch(() => false)) {
    await settingsItem.click();
    await session.page.waitForTimeout(1500);
  }
  const securityTab = session.page.getByRole('tab', { name: /Security/i }).first();
  if (await securityTab.isVisible().catch(() => false)) {
    await securityTab.click();
    await session.page.waitForTimeout(1000);
  }
  const report = await session.page.evaluate(() => {
    const lines = (document.body?.innerText || '').split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const start = lines.findIndex((line) => line === 'Personal access tokens');
    const end = start < 0
      ? -1
      : lines.findIndex((line, index) => index > start && line === 'Connected apps');
    return {
      url: location.href,
      personalAccessTokens: start < 0 ? [] : lines.slice(start, end > start ? end : start + 80),
      revokeButtonCount: Array.from(document.querySelectorAll('button,[role="button"]'))
        .filter((element) => /revoke access/i.test(
          element.getAttribute('aria-label') || element.textContent || '',
        )).length,
    };
  });
  console.log(JSON.stringify(report));
} finally {
  await session.ctx.close().catch(() => {});
}
