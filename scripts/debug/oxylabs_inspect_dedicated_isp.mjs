// Read-only inspection of Oxylabs Dedicated ISP tabs: proxy list, users, whitelist.
import { WSession } from '../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../trajectories/_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://dashboard.oxylabs.io/';
const OUT = join(process.cwd(), '.work', 'oxylabs_inspect_dedicated_isp');
mkdirSync(OUT, { recursive: true });

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[inspect-dedicated] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'oxylabs_inspect_dedicated_isp', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('long');

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: no GSI iframe'); process.exit(1); }
  const popupPromise = s.page.waitForEvent('popup');
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('popup-timeout')), 15000))]);
  if (!popup) { console.log('FAIL: popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded');

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) {
    await humanIdlePause('short');
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break;
  }
  console.log(`[inspect-dedicated] post-login url=${s.page.url()}`);

  async function dump(tag) {
    await humanIdlePause('long');
    const text = await s.page.evaluate(() => document.body.innerText);
    const url = s.page.url();
    writeFileSync(join(OUT, `${tag}.txt`), text);
    writeFileSync(join(OUT, `${tag}.html`), await s.page.content());
    await s.page.screenshot({ path: join(OUT, `${tag}.png`), fullPage: true });
    console.log(`[inspect-dedicated] dumped ${tag} url=${url} textlen=${text.length}`);
  }

  // Direct links for Dedicated ISP tabs.
  const tabs = [
    { tag: 'proxy_list', url: 'https://dashboard.oxylabs.io/en/overview/dedicated-isp/proxy-lists' },
    { tag: 'users', url: 'https://dashboard.oxylabs.io/en/overview/dedicated-isp/users' },
    { tag: 'whitelist', url: 'https://dashboard.oxylabs.io/en/overview/dedicated-isp/whitelist' },
    { tag: 'statistics', url: 'https://dashboard.oxylabs.io/en/overview/dedicated-isp/statistics' },
  ];

  for (const t of tabs) {
    try {
      await s.page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await dump(t.tag);
    } catch (e) {
      console.log(`[inspect-dedicated] ${t.tag} err: ${(e.message || String(e)).slice(0, 120)}`);
    }
  }
  console.log(`PASS: dumped to ${OUT}/`);
} catch (e) {
  console.log('FAIL:', (e.message || String(e)).slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
