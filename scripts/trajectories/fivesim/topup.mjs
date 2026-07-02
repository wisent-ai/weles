// FiveSim (5sim.net) topup via Google SSO.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const { usd } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'fivesim_topup', browser: 'chromium' });
try {
  await s.goto('https://5sim.net/login');
  await humanIdlePause('long');
  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await s.page.locator('button:has-text("Sign in with Google"), a:has-text("Sign in with Google")').filter({ visible: true }).first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 8000))]);  // allow-raw-playwright: Promise.race deadline
  const ok = await googleSso(s, login, { originHost: '5sim.net', page: popup ?? undefined });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 30; i++) { await humanIdlePause('short'); if (!/\/login/.test(s.page.url())) break; }
  await s.page.goto('https://5sim.net/finance', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) {
    await amtIn.click(); await amtIn.fill(String(usd));
    console.log(`[trajectory] amount filled: $${usd}`);
  }

  

  // CONFIRM: Find and click pay button
  const { findAndClickPayButton } = await import('../_shared/services/topup_common.mjs');
  const clicked = await findAndClickPayButton(s.page);
  if (!clicked) {
    console.log('FAIL: could not find pay/checkout button');
    process.exit(1);
  }
  await humanIdlePause('long');
  console.log(`PASS-CHARGED: checkout initiated, url=${s.page.url().slice(0, 100)}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
