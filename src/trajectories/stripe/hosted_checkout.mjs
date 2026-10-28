// Pay the Stripe-hosted Checkout page the session is on, with a card, and
// answer Stripe's own verdict on the payment.
//
// Every product that sells through Stripe Checkout lands on
// checkout.stripe.com, and Stripe refuses raw card numbers over its API, so
// the page is completed the way a person completes it. This is that one
// completion: stripe/pay_checkout.mjs runs it for a session URL it is given,
// and a provider's own purchase flow runs it once its checkout has handed the
// browser to Stripe. Stripe answers the card submit at its payment page's
// confirm endpoint, and that answer is the verdict: an HTTP refusal is thrown
// with Stripe's error code, decline code and message; a payment intent that
// did not succeed (a 3-D Secure requires_action among them) is thrown naming
// its status and next action; a succeeded intent is returned once the
// browser has left the checkout host.

import { fillStripeElements } from '../_shared/services/topup_common.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import {
  pageSettled,
  responseAfterAction,
  urlMatching,
} from '../_shared/page/settled.mjs';
import { humanFill } from '../../../dist/human/keyboard.js';

/** Stripe Checkout's own host. */
export const CHECKOUT_HOST = 'checkout.stripe.com';
// Checkout submits the card to its own payment page's confirm endpoint, and
// Stripe answers there: an `error` object (code, decline_code, message) for
// a refused card, or the payment intent with its status.
const CONFIRM = /^\/v1\/payment_pages\/[^/]+\/confirm$/;

async function visible(locator) {
  return locator.isVisible();
}

/**
 * Type `value` into the visible input `selector` names and confirm the input
 * kept it: compared on its digits when `digits` (Stripe spaces a card number
 * and slashes an expiry as it is typed), else trimmed. False when the page
 * shows no such input. An input that did not keep the value is refused
 * naming it and both lengths, never the value itself.
 */
export async function typeInto(page, selector, value, digits) {
  const input = page.locator(selector).filter({ visible: true }).first();
  if (!(await visible(input))) return false;
  // A field Stripe prefilled (a customer's email) is replaced, not appended to.
  await humanFill(page, input, value);
  const read = (text) => (digits ? text.replace(/\D/g, '') : text.trim());
  const typed = read(value);
  const kept = read(await input.inputValue());
  if (kept !== typed)
    throw new Error(
      `STRIPE_CHECKOUT_INPUT_NOT_KEPT: the checkout field ${selector} did not keep what was typed into it (${typed.length} characters typed, ${kept.length} kept)`,
    );
  return true;
}

/**
 * Pay the Stripe Checkout page `s` is on with `card` ({num, exp, cvc, name,
 * zip}), giving `email` when the page asks for a contact address. Answers the
 * succeeded payment intent.
 */
export async function payHostedCheckout(s, { card, email }) {
  const page = s.page;
  const checkoutHost = new URL(page.url()).hostname;
  if (checkoutHost !== CHECKOUT_HOST)
    throw new Error(
      `STRIPE_CHECKOUT_NOT_OPEN: the session is on ${page.url()}, not on ${CHECKOUT_HOST}`,
    );
  await pageSettled(page);

  // An expired or already-paid session renders no payment form at all;
  // saying so, with what the page shows, is more useful than a missing input.
  if (!(await visible(page.locator('form').first()))) {
    await s.screenshot('session_unusable');
    const shown = await page.locator('body').innerText();
    throw new Error(
      `the checkout page offers no payment form: ${shown.replace(/\s+/g, ' ')}`,
    );
  }

  // Stripe Link intercepts with an email OTP only the account owner can pass.
  // Drop to manual card entry the moment it offers.
  const withoutLink = page
    .locator(
      'button:has-text("Pay without Link"), button:has-text("Enter card details"), button:has-text("Use another")',
    )
    .filter({ visible: true })
    .first();
  if (await visible(withoutLink)) {
    console.log('[stripe-checkout] declining Link, entering the card by hand');
    await humanClickLocator(page, withoutLink);
    await pageSettled(page);
  }

  // A checkout for a European account asks for an email before it submits.
  if (
    email &&
    (await typeInto(
      page,
      'input[name="email"], input#email, input[type="email"]',
      email,
      false,
    ))
  )
    console.log('[stripe-checkout] contact email filled');

  // A checkout may open on a payment-method chooser and render no card
  // fields until Card is selected. Selecting is verified by its effect: try
  // the ways a person could choose the row, and stop at the one that makes a
  // card field appear.
  const cardField = page
    .locator('input[name="cardNumber"], input#cardNumber')
    .filter({ visible: true })
    .first();
  if (!(await visible(cardField))) {
    const attempts = [
      [
        'hidden radio',
        async () => {
          const radio = page.locator('input[type="radio"]').first();
          if (await radio.count()) await radio.check({ force: true });
        },
      ],
      [
        'row text',
        () =>
          humanClickLocator(
            page,
            page.getByText('Card', { exact: true }).first(),
          ),
      ],
      [
        'accordion button',
        () =>
          humanClickLocator(
            page,
            page
              .locator('[data-testid*="card"], [id*="card-tab"]')
              .filter({ visible: true })
              .first(),
          ),
      ],
    ];
    for (const [name, attempt] of attempts) {
      // An attempt that threw names why; one that ran and changed nothing says
      // only that it did not open the form.
      const failure = await attempt().then(
        () => '',
        (error) => `: ${error.message}`,
      );
      await pageSettled(page);
      if (await visible(cardField)) {
        console.log(`[stripe-checkout] card method selected by ${name}`);
        break;
      }
      console.log(
        `[stripe-checkout] ${name} did not open the card form${failure}`,
      );
    }
  }

  // "Save my information" turns the payment into a Link enrolment on a phone
  // nobody here confirms; every checked box is cleared.
  for (const box of await page
    .locator('input[type="checkbox"]')
    .filter({ visible: true })
    .all()) {
    if (await box.isChecked()) {
      await box.uncheck({ force: true });
      console.log('[stripe-checkout] declined "save my information"');
    }
  }
  await s.screenshot('method_selected');

  // A hosted checkout comes in two layouts: the older puts card inputs on the
  // page, the current one puts each field in its own Stripe iframe.
  console.log(`[stripe-checkout] filling the card, exp=${card.exp}`);
  await pageSettled(page);
  if (await visible(cardField)) {
    await typeInto(
      page,
      'input[name="cardNumber"], input#cardNumber',
      card.num,
      true,
    );
    await typeInto(
      page,
      'input[name="cardExpiry"], input#cardExpiry',
      card.exp,
      true,
    );
    await typeInto(page, 'input[name="cardCvc"], input#cardCvc', card.cvc, true);
    console.log('[stripe-checkout] filled the page form');
  } else {
    const filled = await fillStripeElements(page, {
      num: card.num,
      exp: card.exp,
      cvc: card.cvc,
      zip: card.zip,
    });
    console.log(`[stripe-checkout] elements fill: ${JSON.stringify(filled)}`);
    if (!filled.ok) {
      await s.screenshot('card_form_not_found');
      const offered = await page
        .locator('button, [role="button"]')
        .allInnerTexts();
      throw new Error(
        `no card form to fill (${JSON.stringify(filled)}); the page offered: ${offered.filter(Boolean).join(' | ')}`,
      );
    }
  }
  // The hosted page keeps name and postal code outside the Elements frames.
  if (card.name)
    await typeInto(
      page,
      'input[name="billingName"], input#billingName',
      card.name,
      false,
    );
  if (card.zip)
    await typeInto(
      page,
      'input[name="billingPostalCode"], input#billingPostalCode',
      card.zip,
      false,
    );
  // A merchant that collects the billing address asks for it on the page;
  // it is the card's own (TOPUP_CARD_STREET, TOPUP_CARD_CITY), never one
  // written here, which the issuer could decline or flag.
  if (card.street)
    await typeInto(
      page,
      'input[name="billingAddressLine1"], input[autocomplete="address-line1"]',
      card.street,
      false,
    );
  if (card.city)
    await typeInto(
      page,
      'input[name="billingLocality"], input[autocomplete="address-level2"]',
      card.city,
      false,
    );
  await s.screenshot('before_submit');

  const payBtn = page
    .locator('button[type="submit"]')
    .filter({ visible: true })
    .last();
  const response = await responseAfterAction(
    page,
    (request) => {
      const at = new URL(request.url());
      return (
        request.method() === 'POST' &&
        at.hostname === 'api.stripe.com' &&
        CONFIRM.test(at.pathname)
      );
    },
    () => humanClickLocator(page, payBtn),
  );
  console.log('[stripe-checkout] submitted');
  const answer = await response.json();
  if (!response.ok()) {
    await s.screenshot('declined');
    const refusal = answer.error;
    throw new Error(
      `stripe refused the card (HTTP ${response.status()}): ${refusal?.code} ${refusal?.decline_code}: ${refusal?.message}`,
    );
  }
  const intent = answer.payment_intent;
  if (intent?.status !== 'succeeded') {
    // A 3-D Secure challenge (requires_action) belongs to the cardholder's
    // bank and phone; any other status is said as Stripe states it.
    await s.screenshot('not_succeeded');
    throw new Error(
      `stripe answered the payment as ${intent?.status} (next action ${intent?.next_action?.type}); nothing was charged by this run`,
    );
  }
  await urlMatching(page, (u) => new URL(u).hostname !== checkoutHost);
  await s.screenshot('post_submit');
  return intent;
}
