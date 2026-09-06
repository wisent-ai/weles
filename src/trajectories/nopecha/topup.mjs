// NopeCHA topup via Sign in modal → Continue with Google (same-tab OAuth).
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const { usd } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'nopecha_topup', browser: 'chromium' });
try {
  await s.goto('https://nopecha.com/');
  await humanIdlePause('deliberate');
  await s.page.locator('a:has-text("Sign in")').first().click();
  await humanIdlePause('deliberate');
  await s.page.locator('button:has-text("Continue with Google")').filter({ visible: true }).first().click();
  const ok = await googleSso(s, login, { originHost: 'nopecha.com' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }
  await humanIdlePause('long');

  // NopeCHA funds via Manage Billing or Subscribe page.
  await s.page.goto('https://nopecha.com/subscribe', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) { await amtIn.click(); await amtIn.fill(String(usd)); console.log(`[trajectory] amount filled: $${usd}`); }

  

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
} finally { await s.close(); }
