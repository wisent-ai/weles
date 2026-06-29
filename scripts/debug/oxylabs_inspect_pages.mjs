// Read-only dump of several Oxylabs dashboard pages.
import { WSession } from '../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../trajectories/_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://dashboard.oxylabs.io/';
const OUT = join(process.cwd(), '.work', 'oxylabs_inspect_pages');
mkdirSync(OUT, { recursive: true });

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[inspect-pages] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'oxylabs_inspect_pages', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('long');

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: Oxylabs Google GSI iframe not found'); process.exit(1); }
  const popupPromise = s.page.waitForEvent('popup');
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('popup-timeout')), 15000))]);
  if (!popup) { console.log('FAIL: Google login popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded');

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) {
    await humanIdlePause('short');
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break;
  }
  console.log(`[inspect-pages] post-login url=${s.page.url()}`);

  async function dump(tag) {
    await humanIdlePause('long');
    const text = await s.page.evaluate(() => document.body.innerText);
    const url = s.page.url();
    writeFileSync(join(OUT, `${tag}.txt`), text);
    writeFileSync(join(OUT, `${tag}.html`), await s.page.content());
    await s.page.screenshot({ path: join(OUT, `${tag}.png`), fullPage: true });
    console.log(`[inspect-pages] dumped ${tag} url=${url} textlen=${text.length}`);
  }

  const pages = [
    { tag: '00_home', url: 'https://dashboard.oxylabs.io/en/overview' },
    { tag: '01_mobile', url: 'https://dashboard.oxylabs.io/en/overview/MP' },
    { tag: '01_mobile_users', url: 'https://dashboard.oxylabs.io/en/overview/MP/users' },
    { tag: '02_isp', url: 'https://dashboard.oxylabs.io/en/overview/ISP' },
    { tag: '02_isp_users', url: 'https://dashboard.oxylabs.io/en/overview/ISP/users' },
    { tag: '03_dedicated_isp', url: 'https://dashboard.oxylabs.io/en/overview/dedicated-isp/proxy-lists' },
    { tag: '03_dedicated_isp_users', url: 'https://dashboard.oxylabs.io/en/overview/dedicated-isp/users' },
    { tag: '04_billing', url: 'https://dashboard.oxylabs.io/en/billing-plans' },
    { tag: '05_limits', url: 'https://dashboard.oxylabs.io/en/limits-and-spending' },
  ];

  for (const p of pages) {
    try {
      await s.page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await dump(p.tag);
    } catch (e) {
      console.log(`[inspect-pages] ${p.tag} err: ${(e.message || String(e)).slice(0, 120)}`);
    }
  }
  console.log(`PASS: pages dumped to ${OUT}/`);
} catch (e) {
  console.log('FAIL:', (e.message || String(e)).slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
