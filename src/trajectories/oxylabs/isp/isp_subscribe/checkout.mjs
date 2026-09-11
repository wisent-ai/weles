// The Cleverbridge and Stripe checkout: never Link; manual card entry from the shared
// card loader, the cardholder fields, and the most committal button at every step.
import { fillStripeElements } from '../../../_shared/services/topup_common.mjs';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanType } from '../../../../../dist/human/keyboard.js';
import { shot } from './evidence.mjs';

export async function completeCheckout(s) {
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
}
