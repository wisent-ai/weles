// The fixed-tier upgrade, gated behind OXYLABS_ALLOW_TIER_CHANGE=1: Change plan, Continue
// to checkout, the Cleverbridge and Stripe pages, and the charge observation.
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { PLANS } from './plans.mjs';

export async function upgradeTier(s, plan, currentPlanName) {
  // Fixed-tier subscription branch — gated behind explicit OXYLABS_ALLOW_TIER_CHANGE=1
  // env var. Auto-topup cron never sets this flag, so the cron path can only
  // hit the PAYG branch above. Manual operator can run with the flag set
  // when they intentionally want to upgrade tier.
  if (process.env.OXYLABS_ALLOW_TIER_CHANGE !== '1') {
    console.log(`FAIL: current plan=${currentPlanName} but OXYLABS_ALLOW_TIER_CHANGE not set — refusing to commit to a recurring tier subscription from auto-context`);
    process.exit(1);
  }
  const currentRank = PLANS.findIndex(p => p.name === currentPlanName);
  const requestedRank = PLANS.findIndex(p => p.name === plan.name);
  if (currentRank >= requestedRank) {
    console.log(`PASS-NOOP: current plan ${currentPlanName} is at or above requested ${plan.name} — no charge needed`);
    process.exit(0);
  }

  // Real tier upgrade (gated)
  await humanClickLocator(s.page, s.page.locator('a:has-text("My account")').first());
  await humanIdlePause('long');
  const changePlanBtns = await s.page.locator('button:has-text("Change plan"), a:has-text("Change plan")').all();
  if (changePlanBtns.length === 0) { console.log('FAIL: no Change plan button found'); process.exit(1); }
  await changePlanBtns[0].click();
  await humanIdlePause('long');
  const planIndex = requestedRank;
  const pricingBtns = await s.page.locator('button:has-text("Change plan")').all();
  if (pricingBtns.length <= planIndex) {
    console.log(`FAIL: could not find Change plan button for ${plan.name} (found ${pricingBtns.length} buttons)`);
    process.exit(1);
  }
  console.log(`[trajectory] clicking ${plan.name} Change plan button (index ${planIndex})`);
  await pricingBtns[planIndex].click();
  await humanIdlePause('long');

  const continueBtn = s.page.locator('button:has-text("Continue to checkout")').first();
  if (!await continueBtn.isVisible().catch(() => false)) {
    console.log('FAIL: Continue to checkout button not found');
    process.exit(1);
  }
  console.log(`[trajectory] found Continue to checkout for ${plan.name} ($${plan.price})`);
  

  // CONFIRM: Click Continue to checkout -> Cleverbridge/Stripe checkout page.
  // Verified 2026-05-04: post-Continue lands on a Cleverbridge-hosted page
  // with payment-method radios (Credit Card pre-selected) + a green
  // Continue button that triggers the actual Stripe POST.
  let stripeChargeFired = false;
  s.ctx.on('request', (req) => { if (/api\.stripe\.com\/v1\/(payment_intents|setup_intents).*confirm/.test(req.url())) stripeChargeFired = true; });

  console.log(`[trajectory] CONFIRM: clicking Continue to checkout for ${plan.name}`);
  await continueBtn.click();
  await humanIdlePause('long');

  // Now on the Cleverbridge -> Stripe checkout page. Click the second
  // Continue / payment-method continue to advance to card entry.
  const checkoutContinue = s.page.locator('button:has-text("Continue"), input[type="submit"][value*="Continue" i]').filter({ visible: true }).last();
  if (await checkoutContinue.isVisible().catch(() => false)) {
    console.log('[trajectory] clicking Cleverbridge checkout Continue');
    await checkoutContinue.click();
    await humanIdlePause('long');
  }

  // Stripe checkout may surface the Stripe Link 2FA prompt (cited 2026-05-04
  // from oxylabs_v2 frame: "Confirm it's you" with SMS OTP to ***36). Click
  // "Pay without Link" to fall through to direct card entry.
  const payWithoutLink = s.page.locator('button:has-text("Pay without Link"), a:has-text("Pay without Link")').filter({ visible: true }).first();
  if (await payWithoutLink.isVisible().catch(() => false)) { await payWithoutLink.click({ force: true }).catch(() => {}); console.log('[trajectory] clicked "Pay without Link" to bypass Stripe Link 2FA'); await humanIdlePause('deliberate'); }

  // Probe what's actually on the page before fill.
  try {
    await s.page.screenshot({ path: `${runRecordingsDir('oxylabs_topup')}/oxylabs-stripe-state.png`, fullPage: true }).catch(() => {});
    await humanIdlePause('deliberate');
    for (const f of s.page.frames()) {
      try {
        const inputs = await f.evaluate(() => Array.from(document.querySelectorAll('input')).map(i => `${i.type || 'text'}:name=${i.name || ''}:placeholder=${i.placeholder || ''}:autocomplete=${i.autocomplete || ''}`));
        const url = f.url().slice(0, 120);
        if (inputs.length) console.log(`[diag] frame=${url} inputs=${JSON.stringify(inputs).slice(0, 600)}`);
      } catch {}
    }
  } catch {}

  // Fill Stripe Elements card form from TOPUP_CARD_* env vars.
  const { fillStripeElements } = await import('../_shared/services/topup_common.mjs');
  const fill = await fillStripeElements(s.page);
  console.log(`[trajectory] stripe elements fill: ${JSON.stringify(fill)}`);
  if (!fill.ok) { console.log(`FAIL: stripe elements not fully filled — reason=${fill.reason ?? 'partial'}`); process.exit(1); }

  // Stripe-hosted checkout: the final Pay button text varies (Subscribe / Pay).
  const finalBtn = s.page.locator('button:has-text("Subscribe"), button:has-text("Pay"), button[type="submit"]').filter({ visible: true }).last();
  if (await finalBtn.isVisible().catch(() => false)) { await finalBtn.click({ force: true }).catch(() => {}); console.log('[trajectory] clicked final Stripe-checkout submit'); }
  for (let i = 0; i < 30 && !stripeChargeFired; i++) await humanIdlePause('short');

  const url = s.page.url();
  if (stripeChargeFired) console.log(`PASS-CHARGED: Stripe payment_intents/confirm POST fired, url=${url.slice(0, 100)}`);
  else console.log(`FAIL: no Stripe charge POST observed in 30s, url=${url.slice(0, 100)}`);
}
