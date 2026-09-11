// The ISP product page and the start of its checkout: Buy now, the preselected 10 IPs,
// and Buy random locations.
import { writeFileSync } from 'node:fs';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';
import { OUT_DIR, shot, stamp } from './evidence.mjs';

export async function openIspProduct(s) {
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
}

export async function startCheckout(s) {
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
}
