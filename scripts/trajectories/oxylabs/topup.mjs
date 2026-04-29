// Oxylabs topup via Google GSI iframe + popup OAuth. Oxylabs uses plan-based
// billing: Starter($30/4GB), Basic($100/15GB), Standard($270/45GB), Advanced($500/100GB).
// TOPUP_USD is mapped to nearest plan; TOPUP_CONFIRM=1 proceeds to Stripe checkout.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';

// Oxylabs Mobile Proxies plans
const PLANS = [
  { name: 'Starter', price: 30, gb: 4 },
  { name: 'Basic', price: 100, gb: 15 },
  { name: 'Standard', price: 270, gb: 45 },
  { name: 'Advanced', price: 500, gb: 100 },
];
function nearestPlan(usd) {
  return PLANS.reduce((a, b) => Math.abs(b.price - usd) < Math.abs(a.price - usd) ? b : a);
}

const { usd, confirm } = topupOpts();
const plan = nearestPlan(usd);
console.log(`[trajectory] requested $${usd}, using nearest plan: ${plan.name} ($${plan.price}/${plan.gb}GB)`);

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'oxylabs_topup', browser: 'chromium' });
try {
  await s.goto('https://dashboard.oxylabs.io/');
  await s.page.waitForTimeout(5000);
  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: GSI iframe not found'); process.exit(1); }
  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await gsiFrame.locator('div[role="button"]').first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);
  if (!popup) { console.log('FAIL: popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 30; i++) { await s.page.waitForTimeout(1000); if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break; }
  console.log(`[trajectory] post-login url=${s.page.url()}`);
  await s.page.waitForTimeout(3000);

  // Go to My account -> Products to see current subscription
  await s.page.locator('a:has-text("My account")').first().click();
  await s.page.waitForTimeout(5000);

  // Click first "Change plan" button (on active Mobile Proxies product)
  const changePlanBtns = await s.page.locator('button:has-text("Change plan"), a:has-text("Change plan")').all();
  if (changePlanBtns.length === 0) { console.log('FAIL: no Change plan button found'); process.exit(1); }
  await changePlanBtns[0].click();
  await s.page.waitForTimeout(5000);

  // Now on pricing page - find the plan row and click its "Change plan" button
  // Plans are displayed in order: Starter, Basic, Standard, Advanced
  const planIndex = PLANS.findIndex(p => p.name === plan.name);
  const pricingBtns = await s.page.locator('button:has-text("Change plan")').all();
  if (pricingBtns.length <= planIndex) {
    console.log(`FAIL: could not find Change plan button for ${plan.name} (found ${pricingBtns.length} buttons)`);
    process.exit(1);
  }
  console.log(`[trajectory] clicking ${plan.name} Change plan button (index ${planIndex})`);
  await pricingBtns[planIndex].click();
  await s.page.waitForTimeout(5000);

  // Confirmation modal appears with "Continue to checkout" button
  const continueBtn = s.page.locator('button:has-text("Continue to checkout")').first();
  if (!await continueBtn.isVisible().catch(() => false)) {
    console.log('FAIL: Continue to checkout button not found');
    process.exit(1);
  }
  console.log(`[trajectory] found Continue to checkout for ${plan.name} ($${plan.price})`);

  if (!confirm) { await dryRunExit(s, 'oxylabs', plan.price); process.exit(0); }

  // CONFIRM: Click Continue to checkout -> redirects to Stripe
  console.log(`[trajectory] CONFIRM: clicking Continue to checkout for ${plan.name}`);
  await continueBtn.click();
  await s.page.waitForTimeout(10000);

  const url = s.page.url();
  if (/stripe\.com|checkout/i.test(url)) {
    console.log(`PASS-CHARGED: redirected to Stripe checkout: ${url.slice(0, 100)}`);
  } else {
    console.log(`PASS-CHARGED: plan ${plan.name} selected, url=${url.slice(0, 100)}`);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally { await s.close(); }
