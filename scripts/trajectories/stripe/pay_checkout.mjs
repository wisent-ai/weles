// Pay a Stripe-hosted Checkout Session with the workspace topup card.
//
// Stripe refuses raw card numbers over its API — "Sending credit card numbers
// directly to the Stripe API is generally unsafe" — so a hosted checkout can
// only be completed the way a person completes it: in a browser, on
// checkout.stripe.com. Every product that sells through Stripe Checkout
// therefore needs this one trajectory rather than its own copy, which is why it
// takes the session URL as input instead of knowing any provider.
//
// Inputs:
//   STRIPE_CHECKOUT_URL   the https://checkout.stripe.com/c/pay/cs_... page
//   STRIPE_PAY_CONFIRM=1  required: this spends real money
//   TOPUP_CARD_*          card, sourced from the host's topup_card.env
//   STRIPE_PAY_NAME       optional cardholder name override
//   STRIPE_PAY_EMAIL      contact email the hosted page requires
//
// Output: PASS-CHARGED with the final URL, or FAIL with the reason Stripe or
// the page gave. Screenshots land in the session directory at every decision
// point, because a refused card and a refused form look identical in a log.

import { WSession } from '../../../dist/session/wsession.js';
import { fillStripeElements, loadTopupCardEnv, TOPUP_ENV_FILES } from '../_shared/services/topup_common.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';

// One loader, so this works on a host that keeps the card under ~/.weles and
// on a host that keeps it under ~/.stado.
const cardFile = loadTopupCardEnv();

const url = process.env.STRIPE_CHECKOUT_URL ?? '';
if (!/^https:\/\/checkout\.stripe\.com\//.test(url)) {
  console.log('FAIL: STRIPE_CHECKOUT_URL must be a https://checkout.stripe.com/ session page');
  process.exit(2);
}
if (process.env.STRIPE_PAY_CONFIRM !== '1') {
  console.log('FAIL: STRIPE_PAY_CONFIRM=1 required before charging a card');
  process.exit(2);
}
const card = {
  num: (process.env.TOPUP_CARD_NUMBER ?? '').replace(/\s+/g, ''),
  exp: (process.env.TOPUP_CARD_EXP ?? '').replace(/\D/g, ''),
  cvc: process.env.TOPUP_CARD_CVC ?? '',
  zip: process.env.TOPUP_CARD_ZIP ?? '',
  name: process.env.STRIPE_PAY_NAME ?? process.env.TOPUP_CARD_NAME ?? '',
};
if (!card.num || !card.exp || !card.cvc) {
  console.log(`FAIL: TOPUP_CARD_NUMBER/EXP/CVC missing (card file: ${cardFile ?? 'none of ' + TOPUP_ENV_FILES.join(', ')})`);
  process.exit(2);
}

const s = await WSession.start({ label: 'stripe_pay_checkout', browser: 'chromium' });
try {
  await s.goto(url);
  await humanIdlePause('long');

  // An expired or already-paid session renders no form at all, and saying so
  // is more useful than timing out on a missing input.
  const expired = await s.page
    .locator('text=/expired|no longer available|already been paid/i')
    .first()
    .isVisible()
    .catch(() => false);
  if (expired) {
    await s.screenshot('session_unusable');
    console.log('FAIL: the checkout session is expired or already paid');
    process.exit(1);
  }

  // Stripe Link intercepts with an email OTP that only the account owner can
  // pass. Drop to manual card entry the moment it offers.
  const withoutLink = s.page
    .locator('button:has-text("Pay without Link"), button:has-text("Enter card details"), button:has-text("Use another")')
    .filter({ visible: true })
    .first();
  if (await withoutLink.isVisible().catch(() => false)) {
    console.log('[stripe-checkout] declining Link, entering the card by hand');
    await withoutLink.click().catch(() => {});
    await humanIdlePause('short');
  }

  // A checkout for a European account opens on a payment-method chooser -
  // Card, iDEAL, Bancontact, EPS - and renders no card fields until Card is
  // selected. It also asks for an email before it will submit, and pre-checks
  // "Save my information for faster checkout", which turns the flow into Link
  // and demands a phone number. Answer all three before looking for a card
  // form, or the page looks like it has none.
  const email = process.env.STRIPE_PAY_EMAIL?.trim();
  if (email) {
    const emailIn = s.page.locator('input[name="email"], input#email, input[type="email"]').filter({ visible: true }).first();
    if (await emailIn.isVisible().catch(() => false)) {
      await emailIn.click();
      await humanType(s.page, email, { delay: 40 });
      console.log('[stripe-checkout] contact email filled');
    }
  }

  const cardOption = s.page
    .locator('[data-testid="card-accordion-item-button"], [data-testid="card-tab"], input[value="card"], label:has-text("Card")')
    .filter({ visible: true })
    .first();
  if (await cardOption.isVisible().catch(() => false)) {
    await cardOption.click().catch(() => {});
    console.log('[stripe-checkout] selected the Card method');
    await humanIdlePause('short');
  }

  // Link saves the card to a phone number nobody can confirm from here.
  const saveInfo = s.page.locator('input[type="checkbox"]').filter({ visible: true });
  const saveCount = await saveInfo.count().catch(() => 0);
  for (let i = 0; i < saveCount; i++) {
    const box = saveInfo.nth(i);
    if (await box.isChecked().catch(() => false)) {
      await box.uncheck({ force: true }).catch(() => {});
      console.log('[stripe-checkout] declined "save my information"');
    }
  }
  await s.screenshot('method_selected');

  // A hosted checkout comes in two layouts and the difference is invisible in
  // a log: the older one puts card inputs on the page, the current one puts
  // each field in its own Stripe iframe. Try the page first, then the frames
  // through the shared Elements filler every other purchase trajectory uses.
  console.log(`[stripe-checkout] filling ****${card.num.slice(-4)} exp=${card.exp}`);
  const cardIn = s.page.locator('input[name="cardNumber"], input#cardNumber').filter({ visible: true }).first();
  let onPage = false;
  for (let i = 0; i < 20; i++) {
    onPage = await cardIn.isVisible().catch(() => false);
    if (onPage) break;
    const inFrame = s.page.frames().some((f) => /stripe\.com|m\.stripe\.network/.test(f.url()));
    if (inFrame && i > 4) break;
    await humanIdlePause('short');
  }

  if (onPage) {
    await cardIn.click();
    await humanType(s.page, card.num, { delay: 50 });
    const expIn = s.page.locator('input[name="cardExpiry"], input#cardExpiry').filter({ visible: true }).first();
    await expIn.click();
    await humanType(s.page, card.exp, { delay: 50 });
    const cvcIn = s.page.locator('input[name="cardCvc"], input#cardCvc').filter({ visible: true }).first();
    await cvcIn.click();
    await humanType(s.page, card.cvc, { delay: 50 });
    const nameIn = s.page.locator('input[name="billingName"], input#billingName').filter({ visible: true }).first();
    if (card.name && (await nameIn.isVisible().catch(() => false))) {
      await nameIn.click();
      await humanType(s.page, card.name, { delay: 50 });
    }
    const zipIn = s.page
      .locator('input[name="billingPostalCode"], input#billingPostalCode')
      .filter({ visible: true })
      .first();
    if (card.zip && (await zipIn.isVisible().catch(() => false))) {
      await zipIn.click();
      await humanType(s.page, card.zip, { delay: 50 });
    }
    console.log('[stripe-checkout] filled the page form');
  } else {
    const filled = await fillStripeElements(s.page, {
      num: card.num, exp: card.exp, cvc: card.cvc, zip: card.zip,
    });
    console.log(`[stripe-checkout] elements fill: ${JSON.stringify(filled)}`);
    if (!filled.ok) {
      await s.screenshot('card_form_not_found');
      const offered = await s.page.locator('button, [role="button"]').allInnerTexts().catch(() => []);
      console.log(`FAIL: no card form to fill (${filled.reason ?? 'partial'}); the page offered: ${offered.filter(Boolean).slice(0, 8).join(' | ').slice(0, 200)}`);
      process.exit(1);
    }
    // The hosted page keeps name and postal code outside the Elements frames.
    for (const [selector, value] of [
      ['input[name="billingName"], input#billingName', card.name],
      ['input[name="billingPostalCode"], input#billingPostalCode', card.zip],
    ]) {
      if (!value) continue;
      const input = s.page.locator(selector).filter({ visible: true }).first();
      if (await input.isVisible().catch(() => false)) {
        await input.click();
        await humanType(s.page, value, { delay: 50 });
      }
    }
  }
  await s.screenshot('before_submit');

  const payBtn = s.page.locator('button[type="submit"]').filter({ visible: true }).last();
  await payBtn.click();
  console.log('[stripe-checkout] submitted');

  // Three things can happen: the page redirects to the success URL, the issuer
  // demands 3-D Secure, or Stripe renders an inline decline. Watch for all of
  // them rather than assuming the happy one.
  let outcome = 'timeout';
  for (let i = 0; i < 40; i++) {
    await humanIdlePause('short');
    const now = s.page.url();
    if (!/checkout\.stripe\.com/.test(now)) { outcome = 'redirected'; break; }
    const declined = await s.page
      .locator('text=/declined|Your card was|could not be processed|incorrect/i')
      .first()
      .isVisible()
      .catch(() => false);
    if (declined) { outcome = 'declined'; break; }
    const has3ds = await s.page
      .locator('iframe[src*="3d_secure"], iframe[src*="hooks.stripe.com/3d_secure"], iframe[name*="3ds" i]')
      .first()
      .isVisible()
      .catch(() => false);
    if (has3ds) { outcome = '3ds'; break; }
  }

  if (outcome === '3ds') {
    // A live 3-D Secure challenge belongs to the cardholder's bank and phone.
    // Say so, with the screenshot, instead of pretending to wait forever.
    await s.screenshot('3ds_challenge');
    console.log('FAIL: the issuer demanded 3-D Secure, which only the cardholder can pass');
    process.exit(1);
  }
  if (outcome === 'declined') {
    await s.screenshot('declined');
    const text = await s.page
      .locator('text=/declined|Your card was|could not be processed|incorrect/i')
      .first()
      .innerText()
      .catch(() => '');
    console.log(`FAIL: card refused on the page: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    process.exit(1);
  }
  await s.screenshot('post_submit');
  if (outcome !== 'redirected') {
    console.log(`FAIL: still on the checkout page after submitting; url=${s.page.url().slice(0, 120)}`);
    process.exit(1);
  }
  console.log(`PASS-CHARGED: final url=${s.page.url().slice(0, 160)}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
