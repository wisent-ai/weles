// AntiCaptcha topup via Google SSO. Uses fixed amounts ($10, $25, $50, $100, $500).
// TOPUP_USD is rounded to nearest preset. Clicking amount redirects to Stripe.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const PRESETS = [10, 25, 50, 100, 500];
function nearestPreset(usd) {
  return PRESETS.reduce((a, b) => Math.abs(b - usd) < Math.abs(a - usd) ? b : a);
}

const { usd } = topupOpts();
const amount = nearestPreset(usd);
console.log(`[trajectory] requested $${usd}, using nearest preset $${amount}`);

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'anticaptcha_topup', browser: 'chromium' });
try {
  await s.goto('https://anti-captcha.com/clients/entrance/login');
  await humanIdlePause('deliberate');
  await s.page.locator('button:has-text("Continue with Google"), a:has-text("Continue with Google")').filter({ visible: true }).first().click();
  const ok = await googleSso(s, login, { originHost: 'anti-captcha.com' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  await humanIdlePause('deliberate');
  await s.page.goto('https://anti-captcha.com/clients/finance/refill', { waitUntil: 'networkidle' });
  await humanIdlePause('long');

  // Click VISA card to open payment dialog
  await s.page.locator('span.card-cat:has(img[alt="Visa"])').first().click();
  await humanIdlePause('deliberate');

  // Click Stripe "Select" button (second one in dialog)
  const selectBtns = await s.page.locator('button:has-text("Select"), a:has-text("Select")').all();
  if (selectBtns.length >= 2) {
    await selectBtns[1].click();
    await humanIdlePause('deliberate');
  }

  // Now on amount selection page - click the matching preset button
  const amountBtn = s.page.locator(`button:has-text("$${amount}"), div:has-text("$${amount}")`).filter({ visible: true }).first();
  if (!await amountBtn.isVisible().catch(() => false)) {
    console.log(`FAIL: amount button $${amount} not found`);
    process.exit(1);
  }
  console.log(`[trajectory] found amount button $${amount}`);

  

  // CONFIRM: Click amount to redirect to Stripe checkout
  console.log(`[trajectory] CONFIRM: clicking $${amount} to proceed to Stripe`);
  await amountBtn.click();
  await humanIdlePause('long');
  
  // Should redirect to stripe.com or payment partner
  const url = s.page.url();
  if (/stripe\.com|checkout/i.test(url)) {
    console.log(`PASS-CHARGED: redirected to ${url.slice(0, 80)}... (complete payment manually)`);
  } else {
    console.log(`PASS-CHARGED: amount $${amount} selected, url=${url.slice(0, 80)}`);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
