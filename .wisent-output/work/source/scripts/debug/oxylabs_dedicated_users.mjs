// Dump Oxylabs Dedicated ISP Users page to inspect credentials / integration snippet.
import { WSession } from '../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../trajectories/_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://dashboard.oxylabs.io/';
const OUT = join(process.cwd(), '.work', 'oxylabs_dedicated_users');
mkdirSync(OUT, { recursive: true });

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'oxylabs_dedicated_users', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('long');
  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: GSI iframe not found'); process.exit(1); }
  const popupPromise = s.page.waitForEvent('popup');
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('popup-timeout')), 15000))]);
  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO'); process.exit(1); }
  for (let i = 0; i < 60; i++) {
    await humanIdlePause('short');
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break;
  }
  console.log('post-login url=', s.page.url());

  // Navigate directly to Dedicated ISP users list.
  await s.goto('https://dashboard.oxylabs.io/en/overview/dedicated-isp/users');
  await humanIdlePause('deliberate');
  const text = await s.page.evaluate(() => document.body.innerText);
  writeFileSync(join(OUT, 'users.txt'), text);
  writeFileSync(join(OUT, 'users.html'), await s.page.content());
  await s.page.screenshot({ path: join(OUT, 'users.png'), fullPage: true });
  console.log(`dumped users textlen=${text.length} url=${s.page.url()}`);
  console.log(text.slice(0, 2000));
} finally {
  await s.close();
}
