// IPRoyal topup via Google SSO popup with consent click. Dry-run by default.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const { usd, confirm } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'iproyal_topup', browser: 'chromium' });
try {
  await s.goto('https://dashboard.iproyal.com/login');
  await humanIdlePause('deliberate');
  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await s.page.locator('button:has-text("Login with Google")').filter({ visible: true }).first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);  // allow-raw-playwright: Promise.race deadline
  if (!popup) { console.log('FAIL: popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  const ok = await googleSso(s, login, { originHost: 'iproyal.com', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) { await humanIdlePause('short'); if (!/\/login/.test(s.page.url())) break; }

  // IPRoyal's actual topup flow: there is no /balance route (verified
  // 2026-05-04: dashboard.iproyal.com/balance returns 404 Page Not Found).
  // The real entry point is the "+ Add funds" button in the topbar of the
  // home dashboard, next to the $0.00 balance display.
  await s.page.goto('https://dashboard.iproyal.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('deliberate');
  const addFundsBtn = s.page.locator('button:has-text("Add funds"), a:has-text("Add funds")').filter({ visible: true }).first();
  if (await addFundsBtn.isVisible().catch(() => false)) { await addFundsBtn.click(); console.log('[trajectory] clicked "Add funds" topbar button'); await humanIdlePause('deliberate'); }
  else { console.log('FAIL: "Add funds" button not visible on dashboard home'); process.exit(1); }

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) { await amtIn.click(); await amtIn.fill(String(usd)); console.log(`[trajectory] amount filled: $${usd}`); }

  if (!confirm) { await dryRunExit(s, 'iproyal', usd); process.exit(0); }

  // CONFIRM: explicitly select Credit/debit card. Verified 2026-05-05 from
  // probe: the deposit modal renders payment methods as styled buttons
  // (not radios/labels) — text content is "Credit or debit card". Clicking
  // it surfaces Stripe Elements card-number / expiry / cvc / postal frames.
  const cardOption = s.page.locator('button:has-text("Credit or debit card"), [role="button"]:has-text("Credit or debit card"), div:has-text("Credit or debit card")').filter({ visible: true }).first();
  if (await cardOption.isVisible().catch(() => false)) { await cardOption.click({ force: true }).catch(() => {}); console.log('[trajectory] selected Credit/debit card method'); await humanIdlePause('deliberate'); }
  else { console.log('[trajectory] Credit/debit card option not found — proceeding with current selection'); }

  // Probe: walk into each Stripe frame and list all inputs inside.
  try {
    await s.page.screenshot({ path: '.work/iproyal-deposit-state.png', fullPage: true }).catch(() => {});
    await humanIdlePause('deliberate');
    for (const f of s.page.frames()) {
      if (!/js\.stripe\.com|m\.stripe\.network/.test(f.url())) continue;
      try {
        const inputs = await f.evaluate(() => Array.from(document.querySelectorAll('input, [contenteditable="true"]')).map(i => `${i.tagName}:${i.type || ''}:name=${i.name || ''}:placeholder=${i.placeholder || ''}:autocomplete=${i.autocomplete || ''}`));
        const url = f.url().match(/elements-inner-([^-]+(?:-[^-]+)?)|m-outer|m\.stripe\.network/)?.[0] || f.url().slice(0, 60);
        if (inputs.length) console.log(`[diag] frame=${url} inputs=${JSON.stringify(inputs)}`);
      } catch {}
    }
  } catch (e) { console.log('[diag] err:', e.message?.slice(0, 80)); }

  // Fill the Stripe Elements card form with TOPUP_CARD_* env values
  // (issued by the orchestrator from a Privacy.com / Stripe-Issuing card
  // vault). Without these env vars the trajectory cannot fill the form
  // and exits early with a clear blocker reason.
  const { fillStripeElements } = await import('../_shared/services/topup_common.mjs');
  const fill = await fillStripeElements(s.page);
  console.log(`[trajectory] stripe elements fill: ${JSON.stringify(fill)}`);
  if (!fill.ok) { console.log(`FAIL: stripe elements not fully filled — reason=${fill.reason ?? 'partial'}`); process.exit(1); }

  // The actual charge button on iproyal is labelled "Deposit", not "Pay".
  const depositBtn = s.page.locator('button:has-text("Deposit"), button:has-text("Complete deposit")').filter({ visible: true }).first();
  if (!(await depositBtn.isVisible().catch(() => false))) { console.log('FAIL: Deposit button not visible'); process.exit(1); }

  // Watch for Stripe payment_intents POST to confirm the charge actually fires.
  let stripeChargeFired = false;
  s.ctx.on('request', (req) => { if (/api\.stripe\.com\/v1\/(payment_intents|setup_intents).*confirm/.test(req.url())) stripeChargeFired = true; });

  console.log('[trajectory] clicking Deposit button');
  await depositBtn.click();
  for (let i = 0; i < 30 && !stripeChargeFired; i++) await humanIdlePause('short');
  await s.page.screenshot({ path: '.work/iproyal-after-deposit.png', fullPage: true }).catch(() => {});
  // Probe for validation errors / captcha after the deposit click.
  try {
    const post = await s.page.evaluate(() => {
      const errs = Array.from(document.querySelectorAll('[class*="error" i], [role="alert"], [aria-invalid="true"], .invalid')).filter(e => e.offsetParent).map(e => (e.textContent || '').trim().slice(0, 200));
      const captcha = Array.from(document.querySelectorAll('iframe')).filter(i => /captcha|hcaptcha|recaptcha/i.test(i.src || '') && i.offsetParent).map(i => i.src.slice(0, 100));
      return { errs, captcha };
    });
    console.log('[diag] post-deposit:', JSON.stringify(post));
  } catch {}
  if (stripeChargeFired) console.log(`PASS-CHARGED: Stripe payment_intents/confirm POST fired, url=${s.page.url().slice(0, 100)}`);
  else console.log(`FAIL: Deposit clicked but no Stripe charge POST observed in 30s, url=${s.page.url().slice(0, 100)}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally { await s.close(); }
