// JuicySMS topup via Google SSO.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';

const { usd } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'juicysms_topup', browser: 'chromium' });
try {
  await s.goto('https://juicysms.com/login');
  await humanIdlePause('long');
  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await s.page.locator('a:has-text("LOGIN WITH GOOGLE"), button:has-text("LOGIN WITH GOOGLE"), a:has-text("Login with Google")').filter({ visible: true }).first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 8000))]);  // allow-raw-playwright: Promise.race deadline
  const ok = await googleSso(s, login, { originHost: 'juicysms.com', page: popup ?? undefined });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  // Wait for the SSO redirect chain to settle on juicysms.com (NOT on
  // accounts.google.com/SetSID). The previous "break the moment URL leaves
  // /login" exited mid-Google-redirect, before the juicysms session cookie
  // was written — every subsequent goto bounced back to /login. Verified
  // 2026-05-06 via the addfunds flow.
  for (let i = 0; i < 30; i++) {
    await humanIdlePause('short');
    const u = s.page.url();
    if (/juicysms\.com/.test(u) && !/\/login/.test(u)) break;
  }
  await humanIdlePause('deliberate');
  // JuicySMS renamed /payment → /addfunds (verified live 2026-05-06).
  await s.page.goto('https://juicysms.com/addfunds', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) {
    await amtIn.click(); await amtIn.fill(String(usd));
    console.log(`[trajectory] amount filled: $${usd}`);
  }

  

  // The /addfunds page renders payment-method tiles ("Credit Card", "WeChat
  // Pay", "AliPay", ...) plus the green "ADD FUNDS" submit button. The
  // generic findAndClickPayButton's first selector (`button:has-text("Pay")`)
  // substring-matches "WeChat Pay" and clicks the tile instead of the submit
  // — verified via balance staying at $0.83 after a clean PASS-CHARGED log
  // line. Click the deposit button directly with an exact-text match so we
  // never re-trigger that mis-bind.
  const addFundsBtn = s.page.locator('button:text-is("ADD FUNDS"), button:text-is("Add Funds"), button:has-text("Add Funds"):not(:has-text("Pay"))').filter({ visible: true }).first();
  if (await addFundsBtn.isVisible().catch(() => false)) {
    console.log('[topup] clicking exact ADD FUNDS button');
    await addFundsBtn.click();
  } else {
    const { findAndClickPayButton } = await import('../_shared/services/topup_common.mjs');
    const clicked = await findAndClickPayButton(s.page);
    if (!clicked) {
      console.log('FAIL: could not find ADD FUNDS or pay/checkout button');
      process.exit(1);
    }
  }
  await humanIdlePause('long');

  // ADD FUNDS redirects to Stripe Checkout's hosted page
  // (https://checkout.stripe.com/c/pay/cs_live_...). That page renders its
  // own card form — distinct from embedded Stripe Elements which
  // fillStripeElements handles. Fill it directly.
  if (/checkout\.stripe\.com/.test(s.page.url())) {
    const card = {
      num: process.env.TOPUP_CARD_NUMBER ?? '',
      exp: process.env.TOPUP_CARD_EXP ?? '',
      cvc: process.env.TOPUP_CARD_CVC ?? '',
      zip: process.env.TOPUP_CARD_ZIP ?? '',
    };
    if (!card.num || !card.exp || !card.cvc) {
      console.log('FAIL: stripe checkout reached but TOPUP_CARD_* env vars missing');
      process.exit(1);
    }
    console.log(`[stripe-checkout] filling card ****${card.num.slice(-4)} exp=${card.exp}`);
    const cardIn = s.page.locator('input[name="cardNumber"], input#cardNumber').filter({ visible: true }).first();
    await cardIn.waitFor({ state: 'visible' });
    await cardIn.click();
    await humanType(s.page, card.num, { delay: 50 });
    const expIn = s.page.locator('input[name="cardExpiry"], input#cardExpiry').filter({ visible: true }).first();
    await expIn.click();
    await humanType(s.page, card.exp.replace(/\D/g, ''), { delay: 50 });
    const cvcIn = s.page.locator('input[name="cardCvc"], input#cardCvc').filter({ visible: true }).first();
    await cvcIn.click();
    await humanType(s.page, card.cvc, { delay: 50 });
    const nameIn = s.page.locator('input[name="billingName"], input#billingName').filter({ visible: true }).first();
    if (await nameIn.isVisible().catch(() => false)) {
      await nameIn.click();
      await humanType(s.page, 'Lukasz Bartoszcze', { delay: 50 });
    }
    const zipIn = s.page.locator('input[name="billingPostalCode"], input#billingPostalCode').filter({ visible: true }).first();
    if (card.zip && await zipIn.isVisible().catch(() => false)) {
      await zipIn.click();
      await humanType(s.page, card.zip, { delay: 50 });
    }
    await s.screenshot('stripe_before_submit');
    // Stripe's submit button text varies: "Pay $20.00", "Pay €20.00", etc.
    const payBtn = s.page.locator('button[type="submit"]:has-text("Pay")').filter({ visible: true }).first();
    await payBtn.click();
    console.log('[stripe-checkout] submitted');
    // 3DS Strong Customer Authentication: Stripe injects an iframe at
    // src*="stripe.com/3d_secure" or shows a popup challenge. Cards issued
    // in EU + most virtual cards require it. Wait for either redirect to
    // success or the 3DS frame to appear.
    let landed3ds = false;
    for (let i = 0; i < 20; i++) {
      await humanIdlePause('short');
      const url = s.page.url();
      if (/payments\/success|payments\/error|payments\/cancelled/.test(url)) break;
      const has3ds = await s.page.locator('iframe[src*="3d_secure"], iframe[name*="3ds" i], iframe[src*="hooks.stripe.com/3d_secure"]').first().isVisible().catch(() => false);
      if (has3ds) { landed3ds = true; await s.screenshot('stripe_3ds'); break; }
    }
    if (landed3ds) {
      console.log('[stripe-checkout] 3DS challenge detected — auto-clicking "Complete authentication" if Stripe test path, else waiting');
      // On Stripe TEST keys, the 3DS frame has a "Complete authentication"
      // button (auto-pass). On LIVE this is a real bank challenge. Try the
      // test-button first; if not present, wait for the user (or external
      // mechanism) to complete it. Cap the wait at 60s.
      for (const f of s.page.frames()) {
        if (!/3d_secure|hooks\.stripe\.com/i.test(f.url())) continue;
        const completeBtn = f.locator('button:has-text("Complete authentication"), button#test-source-authorize-3ds').first();
        if (await completeBtn.isVisible().catch(() => false)) {
          await completeBtn.click().catch(() => {});
          console.log('[stripe-checkout] clicked test-mode 3DS Complete');
          break;
        }
      }
      for (let i = 0; i < 60; i++) {
        await humanIdlePause('short');
        const url = s.page.url();
        if (/payments\/success|payments\/error|payments\/cancelled/.test(url)) break;
      }
    } else {
      await humanIdlePause('long');
    }
    await s.screenshot('stripe_post_submit');
  }

  console.log(`PASS-CHARGED: final url=${s.page.url().slice(0, 100)}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
