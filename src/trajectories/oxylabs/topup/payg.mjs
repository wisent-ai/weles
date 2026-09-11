// The pay-as-you-go top-up: Add more traffic, the GB amount, the non-refundable
// acknowledgement, and the Stripe form. Exits with the charge outcome.
import { humanIdlePause } from '../../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

export async function topUpPayAsYouGo(s, usd) {
  // Pay-as-you-go path: click "Add more traffic" to top up GB credit.
  // No tier change, no duplicate subscription, no monthly recurring charge.
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
