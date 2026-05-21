// READ-ONLY inspection of our actual Oxylabs account's Dedicated ISP plan.
// Answers "can we switch the burned Dedicated ISP IPs?" from the real
// account, not generic docs: reuses oxylabs/balance.mjs's exact Google-SSO
// login, then NAVIGATES (no mutating clicks) the proxy/ISP management
// pages and dumps text+HTML+screenshot for inspection. Does NOT create,
// reset, subscribe, top up, or buy anything — strictly look-and-dump.
import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://dashboard.oxylabs.io/';
const OUT = join(process.cwd(), '.work', 'oxylabs_inspect_isp');
mkdirSync(OUT, { recursive: true });

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[inspect] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'oxylabs_inspect_isp', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('long');

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: Oxylabs Google GSI iframe not found'); process.exit(1); }
  let popup = null;
  const popupPromise = s.page.waitForEvent('popup');
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  try {
    popup = await Promise.race([
      popupPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('popup-timeout')), 15000)),  // allow-raw-playwright: Promise.race deadline
    ]);
  } catch (e) { console.log(`FAIL: Google login popup did not open (${e.message})`); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded');

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) {
    await humanIdlePause('short');
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break;
  }
  console.log(`[inspect] post-login url=${s.page.url()}`);

  async function dump(tag) {
    await humanIdlePause('long');
    const text = await s.page.evaluate(() => document.body.innerText);  // allow-raw-playwright: read-only innerText, no DOM interaction
    writeFileSync(join(OUT, `${tag}.txt`), text);
    writeFileSync(join(OUT, `${tag}.html`), await s.page.content());
    await s.page.screenshot({ path: join(OUT, `${tag}.png`), fullPage: true });
    console.log(`[inspect] dumped ${tag} (textlen=${text.length}, final=${s.page.url()})`);
  }

  await dump('00_home');

  // Navigate via the REAL left-nav items (guessed URLs 404'd last run).
  // Clicking a nav link to VIEW a page is read-only — no mutation. Capture
  // the Dedicated ISP + ISP product pages and any IP-management sub-tab.
  const NAV = ['Dedicated ISP Proxies', 'ISP Proxies', 'Limits and Spending'];
  for (let i = 0; i < NAV.length; i++) {
    const label = NAV[i];
    try {
      const link = s.page.getByText(label, { exact: false }).first();
      if (!(await link.isVisible().catch(() => false))) { console.log(`[inspect] nav "${label}" not visible`); continue; }
      await humanClickLocator(s.page, link);
      await humanIdlePause('deliberate');
      const tag = `${String(i + 1).padStart(2, '0')}_${label.replace(/[^a-z0-9]+/gi, '_')}`;
      await dump(tag);
      // On the product page, surface any IP-management / replace / setup tab.
      for (const sub of [/IP list/i, /IP management/i, /Replace/i, /Whitelist/i, /Endpoint/i, /Setup/i, /Locations?/i]) {
        const t = s.page.getByText(sub).first();
        if (await t.isVisible().catch(() => false)) {
          await humanClickLocator(s.page, t);
          await humanIdlePause('deliberate');
          await dump(`${tag}__${sub.source.replace(/[^a-z0-9]+/gi, '_').slice(0, 20)}`);
          break;
        }
      }
    } catch (e) {
      console.log(`[inspect] nav "${label}" err: ${(e.message || String(e)).slice(0, 120)}`);
    }
  }
  console.log(`PASS: oxylabs ISP dashboard dumped to ${OUT}/ — inspect txt/html/png`);
} catch (e) {
  console.log('FAIL:', (e.message || String(e)).slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
