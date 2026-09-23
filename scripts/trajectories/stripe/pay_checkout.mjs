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
//   TOPUP_CARD_*          card, sourced from ~/.weles/topup_card.env
//   STRIPE_PAY_NAME       optional cardholder name override
//
// Output: PASS-CHARGED with the final URL, or FAIL with the reason Stripe or
// the page gave. Screenshots land in the session directory at every decision
// point, because a refused card and a refused form look identical in a log.

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';

// Same file every other purchase trajectory reads, same precedence: an
// explicit environment variable wins over the file.
const TOPUP_ENV_FILE = join(homedir(), '.weles', 'topup_card.env');
if (existsSync(TOPUP_ENV_FILE)) {
  for (const raw of readFileSync(TOPUP_ENV_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (k && v && !process.env[k]) process.env[k] = v;
  }
}

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
  console.log(`FAIL: TOPUP_CARD_NUMBER/EXP/CVC missing (looked in env and ${TOPUP_ENV_FILE})`);
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

  console.log(`[stripe-checkout] filling ****${card.num.slice(-4)} exp=${card.exp}`);
  const cardIn = s.page.locator('input[name="cardNumber"], input#cardNumber').filter({ visible: true }).first();
  await cardIn.waitFor({ state: 'visible' });
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
