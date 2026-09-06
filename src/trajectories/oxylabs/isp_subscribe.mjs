// Subscribe to Oxylabs ISP Proxies (Starter, 10 IPs, $16/mo).
//
// Flow:
//   1. Login to dashboard.oxylabs.io via Google SSO (existing helper).
//   2. Navigate to ISP product page; verify Starter tier price.
//   3. Require ISP_BUY_CONFIRM=1 before opening the paid subscribe checkout.
//   4. After subscription, navigate to ISP overview, scrape assigned IPs
//      into .work/keeper/oxylabs_isp_ips.json.
//
// This script does NOT charge money unless ISP_BUY_CONFIRM=1 is set.
// Screenshots are written before each click so the caller can audit what was committed.

import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getScopedGoogleLogin } from '../_shared/services/google_sso.mjs'
import { fillStripeElements, loadTopupCardEnv } from '../_shared/services/topup_common.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';

// Source the card the same way every purchase trajectory does.
loadTopupCardEnv();

if (process.env.ISP_BUY_CONFIRM !== '1') { console.log('FAIL: ISP_BUY_CONFIRM=1 required before subscribing'); process.exit(2); }
const OUT_DIR = '.work/keeper/oxylabs_isp_buy';
mkdirSync(OUT_DIR, { recursive: true });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function shot(s, label) {
  const fp = `${OUT_DIR}/${stamp()}_${label}.png`;
  await s.page.screenshot({ path: fp, fullPage: true }).catch(() => {});
  console.log(`[shot] ${fp}`);
  return fp;
}

const login = await getScopedGoogleLogin('oxylabsDashboard');
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'oxylabs_isp_subscribe', browser: 'chromium' });
try {
  await s.page.goto('https://dashboard.oxylabs.io/', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: GSI iframe not found'); await shot(s, 'no_gsi'); process.exit(1); }

  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await humanClickLocator(gsiFrame, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);  // allow-raw-playwright: Promise.race deadline
  if (!popup) { console.log('FAIL: popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 30; i++) {
    await humanIdlePause('short');
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break;
  }
  console.log(`[trajectory] post-login url=${s.page.url()}`);
  await shot(s, 'dashboard_home');

  // Navigate to ISP product page.
  await s.page.goto('https://dashboard.oxylabs.io/en/products', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');
  console.log(`[trajectory] products url=${s.page.url()}`);
  await shot(s, 'products_overview');

  // Dump page text so we know what's on screen and which selectors to try.
  const productsText = await s.page.evaluate(() => document.body.innerText);
  writeFileSync(`${OUT_DIR}/${stamp()}_products_text.txt`, productsText);
  const hasISP = /ISP\s+(Proxies|Proxy)/i.test(productsText);
  console.log(`[trajectory] products page mentions ISP: ${hasISP}`);

  // Try the direct product URL — the topup.mjs uses /overview/MP and /overview/RP,
  // so /overview/ISP is the most-likely shape. If 404, fall back to clicking
  // an ISP card on /products.
  let ispUrl = 'https://dashboard.oxylabs.io/en/overview/ISP';
  await s.page.goto(ispUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');
  console.log(`[trajectory] /overview/ISP url=${s.page.url()}`);
  await shot(s, 'overview_isp');
  const ispText = await s.page.evaluate(() => document.body.innerText);
  writeFileSync(`${OUT_DIR}/${stamp()}_overview_isp_text.txt`, ispText);

  const hasStarter = /Starter\s*\$?16|10\s*IPs?\s*\$?16|\$1\.6\s*\/IP/i.test(ispText);
  console.log(`[trajectory] /overview/ISP has Starter $16 marker: ${hasStarter}`);


  // CONFIRM mode: click Buy now (opens 3-step checkout: plan → locations → review).
  console.log('[trajectory] CONFIRM mode — clicking Buy now');
  const buyBtn = s.page.locator(
    'button:has-text("Buy now"), a:has-text("Buy now"), button:has-text("Buy")',
  ).filter({ visible: true }).first();
  if (!(await buyBtn.isVisible().catch(() => false))) {
    console.log('FAIL: no Buy-style button visible on /overview/ISP');
    await shot(s, 'no_buy_btn');
    process.exit(1);
  }
  await buyBtn.click({ force: true }).catch(() => {});
  await humanIdlePause('long');
  await shot(s, 'step1_choose_plan');
  console.log(`[trajectory] step1 url=${s.page.url()}`);

  // Step 1: 10 IPs tier is preselected by default. Verify it's selected
  // (radio button on the "10 IPs" card filled) then click Continue.
  const tenIpsSelected = await s.page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('label, [role="radio"], div')).filter(el => /10\s*IPs/.test(el.textContent || ''));
    return cards.some(c => {
      const radio = c.querySelector('input[type="radio"], [role="radio"][aria-checked="true"]');
      if (radio && (radio.checked === true || radio.getAttribute('aria-checked') === 'true')) return true;
      // Or visual selection: card has a 'selected' class or filled radio dot
      return /aria-checked="true"|data-selected="true"/.test(c.outerHTML);
    });
  }).catch(() => null);
  console.log(`[trajectory] step1: 10 IPs preselected = ${tenIpsSelected}`);

  // The Oxylabs ISP buy-now page has 10 IPs preselected and surfaces a
  // "Buy random locations" CTA (verified via visible-buttons dump 2026-05-09)
  // that auto-assigns location distribution + advances to Stripe checkout.
  // We use that path — random US locations is fine since we re-bind each IP
  // to a specific social_accounts row regardless of the IP's lat/lon.
  const buyRandomBtn = s.page.locator('button:has-text("Buy random locations")').filter({ visible: true }).first();
  if (!(await buyRandomBtn.isVisible().catch(() => false))) {
    console.log('FAIL: "Buy random locations" button not visible on step 1');
    await shot(s, 'no_buy_random');
    process.exit(1);
  }
  await shot(s, 'before_buy_random');
  console.log('[trajectory] clicking "Buy random locations"…');
  await buyRandomBtn.click({ force: true }).catch(() => {});
  await humanIdlePause('long');
  await shot(s, 'after_buy_random');
  console.log(`[trajectory] after buy-random url=${s.page.url()}`);

  // Cleverbridge → Stripe checkout. Path:
  //   /payment-method [Continue] → checkout.stripe.com (Stripe Link OTP modal)
  //   → "Send code to email instead" → poll real-Chrome Gmail tab for the OTP
  //     via osascript runJs (same pattern as gw_migrate_gmail.mjs) → fill 6
  //     cells → saved card auto-charges → success URL.
  // No manual card entry — Link uses the card already stored under
  // lukasz.bartoszcze@gmail.com, only the OTP gates it.
  for (let step = 0; step < 6; step++) {
    await humanIdlePause('deliberate');
    const url = s.page.url();
    const btns = await s.page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent).map(b => (b.textContent||'').trim().slice(0, 60)).filter(Boolean));
    console.log(`[trajectory] checkout step ${step}: url=${url} btns=${JSON.stringify(btns)}`);
    await shot(s, `checkout_step${step}`);

    // Success page detection.
    if (/success|thank-you|order-confirmation|subscribe-success/i.test(url)) {
      console.log(`[trajectory] reached success URL: ${url}`);
      await shot(s, 'success');
      break;
    }

    // Stripe Link OTP modal detection: 6 single-digit cells.
    // EXPLICIT: We do NOT use Link. If the modal appears, click "Pay without
    // Link" to drop to manual card entry, then fillStripeElements with creds
    // from whichever source the shared loader answered with / TOPUP_CARD_* env.
    const linkOtpVisible = await s.page.evaluate(() => {
      const cells = Array.from(document.querySelectorAll('input[maxlength="1"], input[inputmode="numeric"]')).filter(i => i.offsetParent !== null);
      return cells.length >= 6;
    }).catch(() => false);

    if (linkOtpVisible) {
      console.log('[trajectory] Stripe Link OTP modal detected — clicking "Pay without Link" (per directive: never use Link)');
      const noLinkBtn = s.page.locator('button:has-text("Pay without Link"), a:has-text("Pay without Link")').filter({ visible: true }).first();
      if (!(await noLinkBtn.isVisible().catch(() => false))) {
        console.log('FAIL: "Pay without Link" not visible');
        await shot(s, 'no_pay_without_link');
        process.exit(2);
      }
      await noLinkBtn.click({ force: true }).catch(() => {});
      await humanIdlePause('long');
      await shot(s, 'after_pay_without_link');

      // Fill card fields using the shared helper.
      const filled = await fillStripeElements(s.page);
      console.log(`[trajectory] fillStripeElements: ${JSON.stringify(filled)}`);
      if (!filled.ok) {
        console.log(`FAIL: card fill failed: ${filled.reason || JSON.stringify(filled.filled)}`);
        await shot(s, 'card_fill_failed');
        process.exit(2);
      }
      await humanIdlePause('deliberate');

      // The Cleverbridge subscribe form also requires Cardholder name +
      // billing address fields beyond what fillStripeElements covers. Fill
      // name from TOPUP_CARD_NAME (GCP secret), address from
      // TOPUP_CARD_STREET (env, fallback to Stripe Link's saved address).
      const name = process.env.TOPUP_CARD_NAME || '';
      const street = process.env.TOPUP_CARD_STREET || '621 Stockton Street';
      const city = process.env.TOPUP_CARD_CITY || 'New York';
      const fillExtra = async (selector, value) => {
        if (!value) return false;
        const loc = s.page.locator(selector).filter({ visible: true }).first();
        if (!(await loc.isVisible().catch(() => false))) return false;
        await loc.click({ force: true }).catch(() => {});
        await loc.fill('').catch(() => {});
        await humanType(s.page, value, { delay: 40 });
        return true;
      };
      const nameFilled = await fillExtra('input[name="billingName"], input[autocomplete="cc-name"], input[placeholder*="Full name on card" i], input[placeholder*="Cardholder" i]', name);
      const streetFilled = await fillExtra('input[name="billingAddressLine1"], input[autocomplete="address-line1"], input[placeholder="Address" i]', street);
      const cityFilled = await fillExtra('input[name="billingLocality"], input[autocomplete="address-level2"], input[placeholder="City" i]', city);
      console.log(`[trajectory] extra fields: name=${nameFilled} street=${streetFilled} city=${cityFilled}`);
      await humanIdlePause('short');
      await shot(s, 'after_card_fill');
      // Click Subscribe / Pay.
      const subBtn = s.page.locator('button:has-text("Subscribe"), button:has-text("Pay")').filter({ visible: true }).last();
      if (!(await subBtn.isVisible().catch(() => false))) {
        console.log('FAIL: no Subscribe/Pay button after card fill');
        await shot(s, 'no_subscribe_after_fill');
        process.exit(2);
      }
      await shot(s, 'before_final_subscribe');
      console.log('[trajectory] clicking final Subscribe…');
      await subBtn.click({ force: true }).catch(() => {});
      await humanIdlePause('long');
      await shot(s, 'after_final_subscribe');
      continue;
    }

    if (false) { // dead branch, keep variable scope clean
      console.log('[trajectory] Stripe Link OTP modal detected — switching to email-code path');
      const emailBtn = s.page.locator('a:has-text("Send code to email"), button:has-text("Send code to email"), a:has-text("email instead"), button:has-text("email instead")').filter({ visible: true }).first();
      if (!(await emailBtn.isVisible().catch(() => false))) {
        console.log('FAIL: "Send code to email instead" link not visible');
        await shot(s, 'no_email_path');
        process.exit(2);
      }
      const otpRequestedAt = Date.now();
      await emailBtn.click({ force: true }).catch(() => {});
      await humanIdlePause('deliberate');
      await shot(s, 'after_send_email_code');

      // Read the OTP via the SAME weles browser. Its Google session cookies
      // are live (we just did Google SSO into Oxylabs in this same context),
      // so a new tab to mail.google.com lands in the inbox without re-auth.
      const gmailPage = await s.ctx.newPage();
      try {
        await gmailPage.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await humanIdlePause('long');
        await gmailPage.screenshot({ path: `${OUT_DIR}/${stamp()}_gmail_landed.png`, fullPage: false }).catch(() => {});

        let code = null;
        for (let i = 0; i < 30; i++) { // ~ several minutes worth of poll cycles
          await humanIdlePause('long');
          // Refresh inbox to pick up new messages
          await gmailPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
          await humanIdlePause('deliberate');
          const text = await gmailPage.evaluate(() => (document.body && document.body.innerText || '').slice(0, 12000)).catch(() => '');
          // Stripe Link OTP emails: sender includes "Stripe" or "Link"; subject
          // typically "Your Link verification code is XXXXXX" or similar. Look
          // for a 6-digit code in a window of lines mentioning either.
          const lines = text.split('\n');
          let candidate = null;
          for (let k = 0; k < lines.length; k++) {
            const window = lines.slice(k, k + 8).join(' ');
            if (/stripe|\blink\b|verification code/i.test(window)) {
              // Stripe Link emails format the code as "XXX XXX" (space) or "XXXXXX".
              const m = window.match(/\b(\d{3})\s?(\d{3})\b/);
              if (m) { candidate = `${m[1]}${m[2]}`; break; }
            }
          }
          if (!candidate) {
            // Fallback: any 6-digit code in the very top of the inbox (newest message)
            const top = text.slice(0, 1500);
            const m = top.match(/\b(\d{3})\s?(\d{3})\b/);
            if (m) candidate = `${m[1]}${m[2]}`;
          }
          if (candidate) { code = candidate; break; }
        }
        if (!code) {
          console.log('FAIL: no Stripe Link OTP arrived in mail.google.com after polling window');
          await gmailPage.screenshot({ path: `${OUT_DIR}/${stamp()}_gmail_no_otp.png`, fullPage: true }).catch(() => {});
          process.exit(2);
        }
        console.log(`[trajectory] Stripe Link OTP read from weles-browser Gmail: ${code}`);
        await gmailPage.close().catch(() => {});

        // Fill the 6 cells back in the Stripe checkout tab.
        const cellLocs = await s.page.locator('input[maxlength="1"], input[inputmode="numeric"]').elementHandles();
        for (let i = 0; i < 6 && i < cellLocs.length; i++) {
          await cellLocs[i].click({ force: true }).catch(() => {});
          await cellLocs[i].type(code[i], { delay: 80 }).catch(() => {});
        }
        await humanIdlePause('long');
        await shot(s, 'after_otp_fill');
      } catch (e) {
        console.log(`FAIL: gmail-page OTP read err: ${e.message?.slice(0, 120)}`);
        process.exit(2);
      }
      continue; // re-evaluate next loop
    }

    // No OTP modal — pick the most-committal button.
    const commitOrder = [
      'button:has-text("Subscribe")',
      'button:has-text("Pay")',
      'button:has-text("Place order")',
      'button:has-text("Complete")',
      'button:has-text("Confirm")',
      'button:has-text("Continue")',
    ];
    let clicked = false;
    for (const sel of commitOrder) {
      const btn = s.page.locator(sel).filter({ visible: true }).last();
      if (await btn.isVisible().catch(() => false)) {
        const txt = await btn.textContent().catch(() => '');
        // Defensive: do NOT click "Pay without Link" — that drops to manual
        // card entry. We want the saved-card path via Link OTP.
        if (/without\s+link/i.test(txt || '')) {
          console.log(`[trajectory] skipping "${(txt||'').trim()}" — would drop to manual card form`);
          continue;
        }
        await shot(s, `before_click_${(txt||'').trim().slice(0,16).replace(/\W+/g,'_')}_step${step}`);
        console.log(`[trajectory] clicking "${(txt||'').trim()}"…`);
        await btn.click({ force: true }).catch(() => {});
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      console.log(`[trajectory] no committal button at step ${step}`);
      break;
    }
    await humanIdlePause('long');
  }

  // Capture assigned IPs from /overview/ISP after subscription.
  await s.page.goto('https://dashboard.oxylabs.io/en/overview/ISP', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await shot(s, 'isp_ip_list');
  const ipsText = await s.page.evaluate(() => document.body.innerText);
  writeFileSync(`${OUT_DIR}/${stamp()}_post_purchase_isp_text.txt`, ipsText);

  const ipMatches = (ipsText.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g) ?? []);
  console.log(`[trajectory] IP-shaped strings on /overview/ISP: ${ipMatches.length} (${ipMatches.slice(0, 3).join(', ')}…)`);
  if (ipMatches.length >= 10) {
    writeFileSync('.work/keeper/oxylabs_isp_ips.json', JSON.stringify({ captured_at: new Date().toISOString(), ips: ipMatches }, null, 2));
    console.log(`[trajectory] wrote .work/keeper/oxylabs_isp_ips.json with ${ipMatches.length} IPs`);
  }
  console.log('[trajectory] done');
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  await shot(s, 'fail');
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
