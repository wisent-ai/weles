// Inspect Oxylabs Dedicated ISP "Replace IPs" checkout flow (no purchase).
import { WSession } from '../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../trajectories/_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), '.work', 'oxylabs_replace_ips_inspect');
mkdirSync(OUT, { recursive: true });

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'oxylabs_replace_ips_inspect', browser: 'chromium' });
try {
  await s.goto('https://dashboard.oxylabs.io/');
  await humanIdlePause('long');
  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  const popupPromise = s.page.waitForEvent('popup');
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('popup-timeout')), 15000))]);
  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO'); process.exit(1); }
  for (let i = 0; i < 60; i++) { await humanIdlePause('short'); if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break; }

  await s.goto('https://dashboard.oxylabs.io/en/overview/dedicated-isp/proxy-lists');
  await humanIdlePause('long');

  const replaceBtn = s.page.getByText('Replace IPs', { exact: false }).filter({ visible: true }).first();
  await replaceBtn.waitFor({ state: 'visible', timeout: 10000 });
  await humanClickLocator(s.page, replaceBtn);
  await humanIdlePause('deliberate');
  await s.page.screenshot({ path: join(OUT, '01_replace_modal.png'), fullPage: true });
  writeFileSync(join(OUT, '01_replace_modal.txt'), await s.page.evaluate(() => document.body.innerText));

  const continueBtn = s.page.getByText('Continue to checkout', { exact: false }).filter({ visible: true }).first();
  if (await continueBtn.isVisible().catch(() => false)) {
    await humanClickLocator(s.page, continueBtn);
    await humanIdlePause('deliberate');
    await s.page.screenshot({ path: join(OUT, '02_checkout.png'), fullPage: true });
    writeFileSync(join(OUT, '02_checkout.txt'), await s.page.evaluate(() => document.body.innerText));
    console.log('checkout url=', s.page.url());
  } else {
    console.log('No continue-to-checkout button visible');
  }
} finally {
  await s.close();
}
