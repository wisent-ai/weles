// Buy 10 US ISP proxies from Oxylabs via Google SSO + buy-locations flow.

import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getScopedGoogleLogin } from '../../_shared/services/google_sso.mjs'
import { fillStripeElements, loadTopupCardEnv } from '../../_shared/services/topup_common.mjs';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { humanIdlePause, humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { COMMIT_BUTTON_SELECTORS } from './selectors.mjs';

loadTopupCardEnv();

if (process.env.ISP_BUY_CONFIRM !== '1') { console.log('FAIL: ISP_BUY_CONFIRM=1 required before buying ISP proxies'); process.exit(2); }
const OUT_DIR = '.work/keeper/oxylabs_isp_buy_us';
mkdirSync(OUT_DIR, { recursive: true });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

async function shot(s, label) {
  const fp = `${OUT_DIR}/${stamp()}_${label}.png`;
  try { await s.page.screenshot({ path: fp, fullPage: true }); } catch {}
  console.log(`[shot] ${fp}`);
  return fp;
}

async function isVisible(loc) {
  try { return await loc.isVisible(); } catch { return false; }
}

const login = await getScopedGoogleLogin('oxylabsDashboard');
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'isp_us', browser: 'chromium' });
try {
  await s.page.goto('https://dashboard.oxylabs.io/', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: GSI iframe not found'); await shot(s, 'no_gsi'); process.exit(1); }

  let popupErr;
  const popupPromise = s.page.waitForEvent('popup').then(p => p, e => { popupErr = e; return null; });
  // Pass s.page (Page), not gsiFrame (Frame): humanMove needs page.mouse.move.
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 15000))]);  // allow-raw-playwright: popup deadline
  if (!popup) { console.log(`FAIL: popup did not open ${popupErr ? '('+popupErr.message+')' : ''}`); await shot(s, 'no_popup'); process.exit(1); }
  try { await popup.waitForLoadState('domcontentloaded'); } catch {}

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); await shot(s, 'sso_fail'); process.exit(1); }

  for (let i = 0; i < 30; i++) {
    await humanIdlePause('short');
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break;
  }
  console.log(`[trajectory] post-login url=${s.page.url()}`);
  await shot(s, 'dashboard_home');

  try { await s.page.goto('https://dashboard.oxylabs.io/en/overview/ISP', { waitUntil: 'domcontentloaded' }); } catch {}
  await humanIdlePause('long');
  await shot(s, 'overview_isp');


  // 2026-05-12: "Buy now" was removed from /overview/ISP. The new entry to
  // expand the plan is "Change IP setup" next to "Current plan 10 IPs".
  const buyBtn = s.page.locator('a:has-text("Change IP setup"), button:has-text("Change IP setup"), button:has-text("Buy now"), a:has-text("Buy now"), button:has-text("Buy")').filter({ visible: true }).first();
  if (!(await isVisible(buyBtn))) { console.log('FAIL: no Buy/Change-IP-setup button on /overview/ISP'); await shot(s, 'no_buy'); process.exit(1); }
  await humanClickLocator(s.page, buyBtn);
  await humanIdlePause('long');
  await shot(s, 'step1_choose_plan');
  console.log(`[trajectory] step1 url=${s.page.url()}`);

  // 2026-05-12: plan-change wizard step 1 = "Choose plan" tier grid with
  // 10 IPs preselected as "Current plan". Click Continue to advance to
  // step 2 "Choose locations". (No "Buy random" / "Choose locations" button
  // on this page anymore — only Continue.)
  const step1Continue = s.page.locator('button:has-text("Continue"), button:has-text("Next"), button:has-text("Choose locations")').filter({ visible: true }).first();
  if (!(await isVisible(step1Continue))) { console.log('FAIL: no Continue on step 1'); await shot(s, 'no_step1_continue'); process.exit(1); }
  await humanClickLocator(s.page, step1Continue);
  await humanIdlePause('long');
  await shot(s, 'step2_locations');
  console.log(`[trajectory] step2 url=${s.page.url()}`);

  // Step 2 layout (keeper-verified 2026-05-12):
  //   - input[name="isReallocation"] (hidden) gates the location editor.
  //   - When ticked: "Available locations" panel lists countries each with
  //     an "Add" button; "Selected locations" panel lists existing
  //     countries each with a trash button (class css-b5jfu9.e1twrqfe0).
  //   - Numeric inputs: input[name="selectedCountries.<idx>.numberOfIps"].
  //   - Plan: tick isReallocation → trash all selected rows → click Add
  //     beside "United States of America" → fill its input with 10.
  const realChecked = await s.page.evaluate(() => document.querySelector('input[name="isReallocation"]')?.checked ?? false);
  if (!realChecked) {
    await humanClickLocator(s.page, s.page.locator('input[name="isReallocation"]').first());
    await humanIdlePause('deliberate');
  }
  await shot(s, 'step2_change_box_ticked');

  // Trash every existing selected-country row. After each click rows reindex,
  // so the "first visible trash" always points to the next victim.
  for (let i = 0; i < 10; i++) {
    const trashLoc = s.page.locator('button.css-b5jfu9.e1twrqfe0').filter({ visible: true }).first();
    if (!(await isVisible(trashLoc))) break;
    await humanClickLocator(s.page, trashLoc);
    await humanIdlePause('short');
    console.log(`[trajectory] trashed selected row #${i + 1}`);
  }

  // Click "Add" next to United States of America in the Available locations.
  // Use Playwright's locator filtering on parent-row text rather than
  // coord-driven evaluate so the click goes through humanClickLocator.
  const usAddLoc = s.page.locator('div, li').filter({ hasText: /^United States of America/ }).locator('button', { hasText: /^Add$/ }).first();
  if (!(await isVisible(usAddLoc))) { console.log('FAIL: no Add button next to United States'); await shot(s, 'no_us_add'); process.exit(1); }
  await humanClickLocator(s.page, usAddLoc);
  await humanIdlePause('short');
  console.log('[trajectory] clicked Add next to United States');

  // Fill the newly-added selected-country input (the only remaining one) with 10.
  await humanFill(s.page, s.page.locator('input[name="selectedCountries.0.numberOfIps"]').first(), '10');
  await humanIdlePause('short');
  const usVal = await s.page.evaluate(() => document.querySelector('input[name="selectedCountries.0.numberOfIps"]')?.value);
  console.log(`[trajectory] US count set to ${usVal}`);
  await shot(s, 'step2_us_set');

  // Click "Change plan" to advance to checkout. Two "Change plan" buttons
  // exist on the page (Order-summary CTA + sidebar). Prefer the .first() —
  // it's the one inside the visible Order-summary block. humanClickLocator
  // auto-scrolls via scrollIntoViewIfNeeded.
  const changePlanBtn = s.page.locator('button:has-text("Change plan"), button:has-text("Confirm change"), button:has-text("Review")').filter({ visible: true }).first();
  if (!(await isVisible(changePlanBtn))) { console.log('FAIL: no Change-plan/Continue on step 2'); await shot(s, 'no_continue_step2'); process.exit(1); }
  await humanClickLocator(s.page, changePlanBtn);
  await humanIdlePause('long');
  await shot(s, 'step3_review');
  console.log(`[trajectory] step3 url=${s.page.url()}`);

  for (let step = 0; step < 6; step++) {
    await humanIdlePause('deliberate');
    const url = s.page.url();
    const btns = await s.page.evaluate(() => Array.from(document.querySelectorAll('button')).filter(b => b.offsetParent).map(b => (b.textContent||'').trim().slice(0, 60)).filter(Boolean));
    console.log(`[trajectory] checkout step ${step}: url=${url} btns=${JSON.stringify(btns)}`);
    await shot(s, `checkout_step${step}`);

    if (/success|thank-you|order-confirmation|subscribe-success/i.test(url)) { console.log(`[trajectory] success: ${url}`); await shot(s, 'success'); break; }

    // HARD RULE: never engage Stripe Link. If a "Pay without Link" button is
    // visible, click it FIRST to drop to the manual card form. Never click
    // "Send code to email instead" / "Send code to phone" — those trigger
    // Link OTPs sent to the user's Gmail which is a hard violation.
    const payWithoutLink = s.page.locator('button:has-text("Pay without Link"), a:has-text("Pay without Link")').filter({ visible: true }).first();
    if (await isVisible(payWithoutLink)) {
      console.log('[trajectory] clicking "Pay without Link" to bypass Link');
      await shot(s, `before_pay_without_link_step${step}`);
      await humanClickLocator(s.page, payWithoutLink);
      await humanIdlePause('long');
      await shot(s, `after_pay_without_link_step${step}`);
      // Stripe Checkout (this product) renders card fields as INLINE inputs
      // on the page (not in elements-inner-* iframes). Fill named inputs.
      const cardName = process.env.TOPUP_CARD_NAME;
      if (!cardName) { console.log('FAIL: TOPUP_CARD_NAME missing'); process.exit(2); }
      if (!process.env.TOPUP_CARD_NUMBER || !process.env.TOPUP_CARD_EXP || !process.env.TOPUP_CARD_CVC || !process.env.TOPUP_CARD_ZIP) {
        console.log('FAIL: TOPUP_CARD_NUMBER/EXP/CVC/ZIP missing in ~/.weles/topup_card.env');
        process.exit(2);
      }
      await humanFill(s.page, s.page.locator('input[name="cardNumber"]'), process.env.TOPUP_CARD_NUMBER);
      await humanFill(s.page, s.page.locator('input[name="cardExpiry"]'), process.env.TOPUP_CARD_EXP);
      await humanFill(s.page, s.page.locator('input[name="cardCvc"]'), process.env.TOPUP_CARD_CVC);
      await humanFill(s.page, s.page.locator('input[name="billingName"]'), cardName);
      // "Enter address manually" expands the autocomplete row into Address /
      // City / ZIP fields. The address autocomplete itself doesn't accept
      // typed input until that link is clicked.
      const enterManual = s.page.locator('button:has-text("Enter address manually"), a:has-text("Enter address manually")').filter({ visible: true }).first();
      if (await isVisible(enterManual)) {
        await humanClickLocator(s.page, enterManual);
        await humanIdlePause('short');
      }
      if (process.env.TOPUP_CARD_ADDRESS) await humanFill(s.page, s.page.locator('input[name="billingAddressLine1"]'), process.env.TOPUP_CARD_ADDRESS);
      if (process.env.TOPUP_CARD_CITY) await humanFill(s.page, s.page.locator('input[name="billingLocality"]'), process.env.TOPUP_CARD_CITY);
      await humanFill(s.page, s.page.locator('input[name="billingPostalCode"]'), process.env.TOPUP_CARD_ZIP);
      await humanIdlePause('long');
      await shot(s, `after_card_fill_step${step}`);
      void fillStripeElements;  // kept imported for iframe-variant Stripe checkouts used by other Oxylabs flows
      continue;
    }

    let clicked = false;
    for (const sel of COMMIT_BUTTON_SELECTORS) {
      const btn = s.page.locator(sel).filter({ visible: true }).last();
      if (await isVisible(btn)) {
        let txt = '';
        try { txt = await btn.textContent(); } catch {}
        // Skip any Link-related commit. Hard rule: never use Link.
        if (/Send code|email instead|phone instead|Use saved/i.test(txt || '')) { console.log(`[trajectory] skip Link path "${(txt||'').trim()}"`); continue; }
        await shot(s, `before_click_${(txt||'').trim().slice(0,16).replace(/\W+/g,'_')}_step${step}`);
        console.log(`[trajectory] click "${(txt||'').trim()}"...`);
        await humanClickLocator(s.page, btn);
        clicked = true;
        break;
      }
    }
    if (!clicked) { console.log(`[trajectory] no commit button at step ${step}`); break; }
    await humanIdlePause('long');
  }

  await s.page.goto('https://dashboard.oxylabs.io/en/overview/ISP', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await shot(s, 'isp_ip_list');
  const ipsText = await s.page.evaluate(() => document.body.innerText);
  writeFileSync(`${OUT_DIR}/${stamp()}_post_purchase_isp_text.txt`, ipsText);
  const ipMatches = (ipsText.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g) ?? []);
  console.log(`[trajectory] IP-shaped strings: ${ipMatches.length}`);
  if (ipMatches.length) writeFileSync('.work/keeper/oxylabs_isp_ips.json', JSON.stringify({ captured_at: new Date().toISOString(), ips: ipMatches }, null, 2));
  console.log('[trajectory] done');
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  await shot(s, 'fail');
  process.exit(1);
} finally {
  try { await s.close(); } catch {}
}
