// Paying for the plan a new Claude account is bought on, with the card
// Skarbiec holds for purchases (`topup-card`, delivered to the run as
// TOPUP_CARD_JSON or the host's card file).
//
// The plan is the one Brama read from the pool's own accounts, named the way
// Anthropic names its rate-limit tier (`default_claude_max_<multiplier>`).
// The multiplier in that name is the choice the Max page offers; a tier of
// another shape is refused by name rather than bought as something else.

import { humanFill } from '../../../../dist/human/keyboard.js';
import { pageCondition, pageSettled } from '../../_shared/page/settled.mjs';
import {
  fillStripeElements,
  loadTopupCardEnv,
} from '../../_shared/services/topup_common.mjs';
import { AuthenticationFailure } from '../../_shared/subscription-auth/oauth.mjs';
import { clickNamed, failOnPage } from './page_steps.mjs';

/** The Max page, where every Max multiplier is sold. */
const MAX_PAGE = new URL('/upgrade/max', 'https://claude.ai');

/** A Max tier as Anthropic names it, and the multiplier it carries. */
const MAX_TIER = /^default_claude_max_(\w+)$/;

/** The control that takes the chosen plan to payment. */
const PROCEED = /^(upgrade|subscribe|continue|get max|choose|select)/i;

/** The control that submits the payment. */
const PAY = /^(subscribe|pay|upgrade|confirm|start|purchase)/i;

/** The card's own name field, when the checkout asks for one. */
const CARD_NAME =
  'input[autocomplete="cc-name"],input[name="name"],input[name="billingName"]';

/** A card issuer's challenge over the payment form. */
const CHALLENGE =
  'iframe[src*="three-ds"],iframe[name*="challenge" i],iframe[src*="3ds"]';

function card() {
  const source = loadTopupCardEnv();
  if (!source)
    throw new AuthenticationFailure(
      'purchase_card_missing',
      'checkout',
      'no purchase card reached this run: TOPUP_CARD_JSON is not set and no host card file exists',
    );
  const missing = [
    'TOPUP_CARD_NUMBER',
    'TOPUP_CARD_EXP',
    'TOPUP_CARD_CVC',
  ].filter((name) => !process.env[name]);
  if (missing.length)
    throw new AuthenticationFailure(
      'purchase_card_incomplete',
      'checkout',
      `the purchase card from ${source} lacks ${missing.join(', ')}`,
    );
  return {
    num: process.env.TOPUP_CARD_NUMBER,
    exp: process.env.TOPUP_CARD_EXP,
    cvc: process.env.TOPUP_CARD_CVC,
    zip: process.env.TOPUP_CARD_ZIP,
    name: process.env.TOPUP_CARD_NAME,
  };
}

/** Ask the operator to approve a payment his card issuer holds for him. */
function requestApproval(label) {
  process.stderr.write(
    `OPERATOR_REQUEST ${JSON.stringify({
      kind: 'payment_approval',
      instruction: `Approve the card payment for Claude ${label} in the card issuer's app; the purchase continues when the payment page moves on`,
    })}\n`,
  );
}

/**
 * Buy `tier` for the signed-in account and wait for claude.ai to say the
 * payment went through or was refused. Answers what was bought.
 */
export async function buyPlan(session, tier, mark) {
  const max = MAX_TIER.exec(tier);
  if (!max)
    throw new AuthenticationFailure(
      'plan_tier_unknown',
      'checkout',
      `Weles buys Claude Max tiers (default_claude_max_<multiplier>); the pool's tier ${tier} is not one`,
    );
  const multiplier = max[1];
  const label = `Max ${multiplier}`;
  const purchaseCard = card();
  const page = session.page;
  await session.goto(MAX_PAGE.href);
  await pageSettled(page);
  mark('plan_page');
  if (!(await clickNamed(page, new RegExp(`\\b${multiplier}\\b`, 'i'))))
    await failOnPage(page, 'plan_choice_missing', 'checkout', `the Max page offers no ${label} choice`);
  if (!(await clickNamed(page, PROCEED)))
    await failOnPage(page, 'plan_proceed_missing', 'checkout', `the Max page offers no control to buy ${label}`);
  mark('card_entry');
  const entered = await fillStripeElements(page, purchaseCard);
  if (!entered.ok)
    await failOnPage(
      page,
      'card_entry_failed',
      'checkout',
      `the card could not be entered on the payment form: ${JSON.stringify(entered)}`,
    );
  const nameField = page.locator(CARD_NAME).filter({ visible: true }).first();
  if (
    purchaseCard.name &&
    (await nameField.count()) &&
    !(await nameField.inputValue())
  )
    await humanFill(page, nameField, purchaseCard.name);
  if (!(await clickNamed(page, PAY)))
    await failOnPage(page, 'payment_submit_missing', 'checkout', 'the payment form offers no control to pay');
  mark('payment_submitted');
  for (;;) {
    const outcome = await pageCondition(
      page,
      (challenge) => {
        const text = document.body.innerText;
        if (
          /declined|was not successful|insufficient funds|could not be processed|payment failed/i.test(text)
        )
          return 'declined';
        if (document.querySelector(challenge)) return 'challenge';
        if (
          location.pathname.startsWith('/new') ||
          /welcome to (claude )?max|you.re (now )?(on|subscribed)|thanks for (upgrading|subscribing)|subscription is active/i.test(text)
        )
          return 'paid';
        return false;
      },
      CHALLENGE,
    );
    if (outcome === 'paid') {
      mark('plan_paid');
      return { plan: label, tier };
    }
    if (outcome === 'declined')
      await failOnPage(page, 'payment_declined', 'checkout', `claude.ai refused the card for ${label}`);
    mark('payment_challenge');
    requestApproval(label);
    await pageCondition(
      page,
      (challenge) => !document.querySelector(challenge),
      CHALLENGE,
    );
  }
}
