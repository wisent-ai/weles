// IPRoyal balance check via Google SSO. Popup-based GSI flow with consent
// step handled by googleSso helper.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://dashboard.iproyal.com/login';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'iproyal_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('deliberate');

  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await s.page.locator('button:has-text("Login with Google"), button:has-text("Continue with Google")').filter({ visible: true }).first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);  // allow-raw-playwright: Promise.race deadline
  if (!popup) { console.log('FAIL: Google login popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});

  const ok = await googleSso(s, login, { originHost: 'iproyal.com', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) {
    await humanIdlePause('short');
    if (!/\/login/.test(s.page.url())) break;
  }
  console.log(`[trajectory] post-login url=${s.page.url()}`);
  if (/\/login/.test(s.page.url())) {
    await s.page.goto('https://dashboard.iproyal.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await humanIdlePause('long');
  }

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = join(process.cwd(), '.work', 'iproyal_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); } catch {}
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
    console.log(`FAIL: IPRoyal balance regex did not match — full dashboard text dumped to ${dir}/`);
    process.exit(1);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const r1 = await patchEffectiveBalance('IPRoyal Residential', balance);
  const r2 = await patchEffectiveBalance('IPRoyal Mobile', balance);
  if (!r1 || !r2) { console.log(`FAIL: PATCH residential=${r1} mobile=${r2}`); process.exit(1); }
  console.log(`PASS: dashboard=$${balance} (effective balance written + probed)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
