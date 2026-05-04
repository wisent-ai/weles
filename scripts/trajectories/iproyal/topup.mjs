// IPRoyal topup via Google SSO popup with consent click. Dry-run by default.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';

const { usd, confirm } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'iproyal_topup', browser: 'chromium' });
try {
  await s.goto('https://dashboard.iproyal.com/login');
  await s.page.waitForTimeout(4000);
  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await s.page.locator('button:has-text("Login with Google")').filter({ visible: true }).first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);
  if (!popup) { console.log('FAIL: popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  const ok = await googleSso(s, login, { originHost: 'iproyal.com', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) { await s.page.waitForTimeout(1000); if (!/\/login/.test(s.page.url())) break; }

  // IPRoyal's actual topup flow: there is no /balance route (verified
  // 2026-05-04: dashboard.iproyal.com/balance returns 404 Page Not Found).
  // The real entry point is the "+ Add funds" button in the topbar of the
  // home dashboard, next to the $0.00 balance display.
  await s.page.goto('https://dashboard.iproyal.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await s.page.waitForTimeout(4000);
  const addFundsBtn = s.page.locator('button:has-text("Add funds"), a:has-text("Add funds")').filter({ visible: true }).first();
  if (await addFundsBtn.isVisible().catch(() => false)) { await addFundsBtn.click(); console.log('[trajectory] clicked "Add funds" topbar button'); await s.page.waitForTimeout(4000); }
  else { console.log('FAIL: "Add funds" button not visible on dashboard home'); process.exit(1); }

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) { await amtIn.click(); await amtIn.fill(String(usd)); console.log(`[trajectory] amount filled: $${usd}`); }

  if (!confirm) { await dryRunExit(s, 'iproyal', usd); process.exit(0); }

  // CONFIRM: explicitly select Credit/debit card (default selection is
  // PayPal which redirects out to PayPals own checkout — Stripe direct
  // charge requires the card option). Verified 2026-05-04 from a frame
  // capture of the deposit page.
  const cardOption = s.page.locator('label:has-text("Credit or debit card"), label:has-text("Credit/debit"), input[value*="card" i] + *, [class*="radio"]:has-text("Credit")').filter({ visible: true }).first();
  if (await cardOption.isVisible().catch(() => false)) { await cardOption.click(); console.log('[trajectory] selected Credit/debit card method'); await s.page.waitForTimeout(1500); }
  else { console.log('[trajectory] Credit/debit card option not found — proceeding with current selection'); }

  // The actual charge button on iproyal is labelled "Deposit", not "Pay".
  const depositBtn = s.page.locator('button:has-text("Deposit"), button:has-text("Complete deposit")').filter({ visible: true }).first();
  if (!(await depositBtn.isVisible().catch(() => false))) { console.log('FAIL: Deposit button not visible'); process.exit(1); }

  // Watch for Stripe payment_intents POST to confirm the charge actually
  // fires (the previous PASS-CHARGED was a false positive — clicked Pay
  // text on the PayPal radio, no Stripe charge POST).
  let stripeChargeFired = false;
  s.ctx.on('request', (req) => { if (/api\.stripe\.com\/v1\/(payment_intents|setup_intents).*confirm/.test(req.url())) stripeChargeFired = true; });

  console.log('[trajectory] clicking Deposit button');
  await depositBtn.click();
  for (let i = 0; i < 30 && !stripeChargeFired; i++) await s.page.waitForTimeout(1000);
  if (stripeChargeFired) console.log(`PASS-CHARGED: Stripe payment_intents/confirm POST fired, url=${s.page.url().slice(0, 100)}`);
  else console.log(`FAIL: Deposit clicked but no Stripe charge POST observed in 30s, url=${s.page.url().slice(0, 100)}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally { await s.close(); }
