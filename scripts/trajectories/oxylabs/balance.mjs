// Oxylabs balance check via Google GSI iframe button + popup-based OAuth.
// One scrape covers BOTH 'Oxylabs Residential' and 'Oxylabs Mobile' rows.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';

const LOGIN_URL = 'https://dashboard.oxylabs.io/';
const BILLING_URL = 'https://dashboard.oxylabs.io/en/billing-plans';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'oxylabs_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await s.page.waitForTimeout(5000);

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: Oxylabs Google GSI iframe not found'); process.exit(1); }

  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await gsiFrame.locator('div[role="button"]').first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);
  if (!popup) { console.log('FAIL: Google login popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) {
    await s.page.waitForTimeout(1000);
    const u = s.page.url();
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(u)) break;
  }
  console.log(`[trajectory] post-login url=${s.page.url()}`);

  // Oxylabs uses GB-based prepaid plans, not USD wallets. Click into the
  // active product to see remaining traffic.
  for (const txt of [/Mobile Proxies/i, /Residential/i, /Limits and Spending/i]) {
    const btn = s.page.getByText(txt).first();
    if (await btn.isVisible().catch(() => false)) { await btn.click({ force: true }).catch(() => {}); await s.page.waitForTimeout(3000); break; }
  }
  await s.page.waitForTimeout(5000);

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  // Oxylabs displays "X.XX GB" remaining on the product page. Try GB first; fall back to $ pattern.
  let balance = (text.match(/(?:remaining|left|available)[^\n]{0,30}([0-9]+(?:\.[0-9]+)?)\s*GB/i) || [])[1];
  if (balance != null) { balance = Number(balance); console.log(`[trajectory] GB remaining=${balance}`); }
  else { balance = parseBalanceFromText(text); }
  if (balance == null) {
    // No balance displayed — account is on a fully-consumed plan or no active product. Persist 0.
    console.log('[trajectory] no balance visible; recording $0');
    balance = 0;
  }
  console.log(`[trajectory] balance=${balance}`);

  // patchEffectiveBalance does a real CONNECT through the upstream — if 407,
  // overrides balance to 0 so cron decisions reflect EFFECTIVE balance.
  const r1 = await patchEffectiveBalance('Oxylabs Residential', balance);
  const r2 = await patchEffectiveBalance('Oxylabs Mobile', balance);
  if (!r1 || !r2) { console.log(`FAIL: PATCH residential=${r1} mobile=${r2}`); process.exit(1); }
  console.log(`PASS: dashboard=$${balance} (effective balance written + probed)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
