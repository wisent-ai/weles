// Oxylabs topup via Google GSI iframe + popup OAuth. Oxylabs uses plan-based
// billing: Starter($30/4GB), Basic($100/15GB), Standard($270/45GB), Advanced($500/100GB).
// TOPUP_USD is mapped to nearest plan; TOPUP_CONFIRM=1 proceeds to Stripe checkout.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

// Oxylabs Mobile Proxies plans
const PLANS = [
  { name: 'Starter', price: 30, gb: 4 },
  { name: 'Basic', price: 100, gb: 15 },
  { name: 'Standard', price: 270, gb: 45 },
  { name: 'Advanced', price: 500, gb: 100 },
];
function nearestPlan(usd) {
  return PLANS.reduce((a, b) => Math.abs(b.price - usd) < Math.abs(a.price - usd) ? b : a);
}

const { usd, confirm } = topupOpts();
const plan = nearestPlan(usd);
console.log(`[trajectory] requested $${usd}, using nearest plan: ${plan.name} ($${plan.price}/${plan.gb}GB)`);

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'oxylabs_topup', browser: 'chromium' });
try {
  await s.goto('https://dashboard.oxylabs.io/');
  await humanIdlePause('long');
  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: GSI iframe not found'); process.exit(1); }
  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await humanClickLocator(gsiFrame, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);  // allow-raw-playwright: Promise.race deadline
  if (!popup) { console.log('FAIL: popup did not open'); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 30; i++) { await humanIdlePause('short'); if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break; }
  console.log(`[trajectory] post-login url=${s.page.url()}`);
  await humanIdlePause('deliberate');

  // Oxylabs subscription model (verified 2026-05-05 via /MP/plan-change +
  // /RP/overview body scrapes): each product (MP, RP) supports BOTH a
  // fixed-tier monthly subscription (Starter $30/Basic $100/Standard $270/
  // Advanced $500) AND pay-as-you-go GB credit topups via the page-level
  // "Add more traffic" button. Auto-topup must use the PAYG path only —
  // tier subscriptions are recurring monthly charges that the user must
  // commit to explicitly. Fixed-tier upgrade lives in this file as a
  // separate branch but is gated to never run from auto-cron context.
  await s.goto('https://dashboard.oxylabs.io/en/overview/MP', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');
  const planText = await s.page.evaluate(() => document.body.innerText);
  const isPayAsYouGo = /Current plan\s*\|?\s*Pay as you go/i.test(planText) || /\bPay as you go\b/i.test(planText);
  let currentPlanName = isPayAsYouGo ? 'Pay as you go' : null;
  if (!currentPlanName) {
    for (const p of PLANS) {
      if (new RegExp(`\\b${p.name}\\b\\s*(Plan|\\$${p.price}|/mo|month)`, 'i').test(planText)) {
        currentPlanName = p.name; break;
      }
    }
  }
  console.log(`[trajectory] current plan=${currentPlanName ?? 'unknown'}; requested=${plan.name}`);
  if (!currentPlanName) {
    console.log(`FAIL: could not detect current Oxylabs plan from /overview/MP — refusing to charge with unknown state`);
    process.exit(1);
  }

  // Pay-as-you-go path: click "Add more traffic" to top up GB credit.
  // No tier change, no duplicate subscription, no monthly recurring charge.
  if (isPayAsYouGo) {
    console.log(`[trajectory] Pay-as-you-go account — using "Add more traffic" topup path`);
    const addTrafficBtn = s.page.locator('button:has-text("Add more traffic"), a:has-text("Add more traffic")').filter({ visible: true }).first();
    if (!(await addTrafficBtn.isVisible().catch(() => false))) {
      console.log('FAIL: "Add more traffic" button not visible on /overview/MP — Pay-as-you-go topup path requires this button');
      process.exit(1);
    }
    // Cited from /MP/plan-change probe: PAYG modal has amount input
    // 1-50 GB, $9/GB, already-checked nonrefundableCondition checkbox,
    // Cancel + Continue buttons. Compute GB from USD using floor so we
    // never exceed the budget ceiling.
    const GB_PRICE = 9;
    const targetGb = Math.max(1, Math.floor(usd / GB_PRICE));
    console.log(`[trajectory] targeting ${targetGb} GB at $${GB_PRICE}/GB (total $${targetGb * GB_PRICE} for budget $${usd})`);
    await addTrafficBtn.click({ force: true }).catch(() => {});
    await humanIdlePause('long');
    await s.page.screenshot({ path: `${runRecordingsDir('oxylabs_topup')}/oxylabs-add-traffic.png`, fullPage: true }).catch(() => {});
    let amountSet = false;
    const sliderInput = s.page.locator('input[type="range"]').filter({ visible: true }).first();
    if (await sliderInput.isVisible().catch(() => false)) {
      await sliderInput.focus();
      const cur = Number(await sliderInput.evaluate((el) => el.value));
      const delta = targetGb - cur;
      const key = delta >= 0 ? 'ArrowRight' : 'ArrowLeft';
      for (let i = 0; i < Math.abs(delta); i++) await s.page.keyboard.press(key);
      const after = Number(await sliderInput.evaluate((el) => el.value));
      console.log(`[trajectory] slider moved ${cur} -> ${after} (target ${targetGb})`);
      if (after !== targetGb) { console.log(`FAIL: slider stopped at ${after} not target ${targetGb}`); process.exit(1); }
      amountSet = true;
    }
    if (!amountSet) {
      const numIn = s.page.locator('input[type="number"], input[inputmode="numeric"]').filter({ visible: true }).first();
      if (await numIn.isVisible().catch(() => false)) {
        await numIn.click(); await numIn.fill(String(targetGb));
        console.log(`[trajectory] number input filled: ${targetGb}`);
        amountSet = true;
      }
    }
    if (!amountSet) {
      // Cited screenshot 2026-05-05: PAYG modal renders icon-only "−" / "+"
      // stepper buttons (textContent="") flanking the GB display. Find
      // every empty-text visible button and click each, watching the
      // "Amount of traffic" digit. The one that increments is the +.
      const readGb = async () => s.page.evaluate(() => {
        const m = (document.body.innerText.match(/Amount of traffic[^\d]*(\d+)\s*GB/) || [])[1];
        return m ? Number(m) : null;
      });
      // Cited frame 2026-05-05 (recordings/page@2882...webm at 1:44):
      // stepper row is "− [N GB] +" — circular icon buttons at the row's
      // left/right edges, with the "<N> GB" big text in the middle. Find
      // the row by structure: <div> with ≥3 children where the middle has
      // "<N> GB" text and the first+last contain SVG (icon stepper).
      const iconBtns = await s.page.evaluateHandle(() => {
        const h1 = Array.from(document.querySelectorAll('h1, h2, h3')).find(el => /Purchase traffic/i.test(el.textContent || ''));
        if (!h1) return [];
        let modal = h1.parentElement;
        while (modal && modal !== document.body) {
          const t = modal.textContent || '';
          if (/Cancel/.test(t) && /Continue/.test(t)) break;
          modal = modal.parentElement;
        }
        if (!modal || modal === document.body) return [];
        return Array.from(modal.querySelectorAll('button, [role="button"], div, span')).filter(el => {
          if (!el.offsetParent || (el.textContent || '').trim() !== '' || !el.querySelector('svg')) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 16 && r.width <= 80 && r.height >= 16 && r.height <= 80;
        });
      });
      const iconBtnCount = await iconBtns.evaluate((arr) => arr.length);
      console.log(`[diag] icon-with-svg count: ${iconBtnCount}`);
      for (let i = 0; i < iconBtnCount; i++) {
        const before = await readGb();
        // Use page.mouse.click via getBoundingClientRect to issue a real
        // synthetic mouse click — el.click() dispatches a click event that
        // many React components ignore for security-sensitive paths.
        const box = await iconBtns.evaluate((arr, idx) => { const r = arr[idx].getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2, w: r.width, h: r.height }; }, i);
        if (box.w === 0 || box.h === 0) continue;
        await s.page.mouse.click(box.x, box.y);
        await humanIdlePause('short');
        const after = await readGb();
        if (after != null && before != null && after > before) {
          console.log(`[trajectory] + button at icon idx=${i} pos=(${Math.round(box.x)},${Math.round(box.y)}) (${before}->${after})`);
          for (let j = 0; j < targetGb - after; j++) {
            await s.page.mouse.click(box.x, box.y);
            await humanIdlePause('short');
          }
          const final = await readGb();
          console.log(`[trajectory] final GB: ${final} (target ${targetGb})`);
          if (final === targetGb) amountSet = true;
          break;
        }
      }
    }
    if (!amountSet) { console.log('FAIL: no working increment button found'); process.exit(1); }
    // Cited frame 2026-05-05: checkbox starts UNCHECKED, Continue is
    // disabled until ticked. Click the wrapper label (input itself is
    // hidden by Stripe-style styling so direct click is no-op).
    const refundCb = s.page.locator('input[name="nonrefundableCondition"]').first();
    if (await refundCb.count() > 0) {
      const was = await refundCb.isChecked().catch(() => false);
      if (!was) {
        const box = await refundCb.evaluate((el) => { const lab = el.closest('label'); const r = (lab || el).getBoundingClientRect(); return { x: r.left + 10, y: r.top + r.height/2 }; });
        await s.page.mouse.click(box.x, box.y);
        await humanIdlePause('short');
      }
      const now = await refundCb.isChecked().catch(() => false);
      console.log(`[trajectory] non-refundable: was=${was} now=${now}`);
      if (!now) { console.log('FAIL: could not check non-refundable acknowledgement'); process.exit(1); }
    }

    if (!confirm) { await dryRunExit(s, 'oxylabs_payg', targetGb * GB_PRICE); process.exit(0); }

    // CONFIRM: Click Continue → Stripe form → fill + submit.
    let stripeChargeFired = false;
    s.ctx.on('request', (req) => { if (/api\.stripe\.com\/v1\/(payment_intents|setup_intents).*confirm/.test(req.url())) stripeChargeFired = true; });
    const continueBtn = s.page.locator('button:has-text("Continue")').filter({ visible: true }).first();
    if (!(await continueBtn.isVisible().catch(() => false))) { console.log('FAIL: Continue button not visible'); process.exit(1); }
    await continueBtn.click({ force: true });
    console.log('[trajectory] clicked Continue — expecting Stripe form');
    await humanIdlePause('long');
    const { fillStripeElements } = await import('../_shared/services/topup_common.mjs');
    const fill = await fillStripeElements(s.page);
    console.log(`[trajectory] stripe elements fill: ${JSON.stringify(fill)}`);
    if (!fill.ok) { console.log(`FAIL: stripe elements not filled — reason=${fill.reason ?? 'partial'}`); process.exit(1); }
    const finalBtn = s.page.locator('button:has-text("Pay"), button:has-text("Subscribe"), button[type="submit"]').filter({ visible: true }).last();
    if (await finalBtn.isVisible().catch(() => false)) { await finalBtn.click({ force: true }).catch(() => {}); console.log('[trajectory] clicked final Stripe submit'); }
    for (let i = 0; i < 30 && !stripeChargeFired; i++) await humanIdlePause('short');
    if (stripeChargeFired) console.log(`PASS-CHARGED: Stripe payment_intents/confirm POST fired — purchased ${targetGb} GB at $${GB_PRICE}/GB ($${targetGb * GB_PRICE})`);
    else console.log(`FAIL: no Stripe charge POST observed in 30s, url=${s.page.url().slice(0, 100)}`);
    process.exit(stripeChargeFired ? 0 : 1);
  }

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
  if (!confirm) { await dryRunExit(s, 'oxylabs', plan.price); process.exit(0); }

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
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally { await s.close(); }
