// Pingproxies (Byteful) topup via Google SSO.
import { WSession } from '../../../dist/session/wsession.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';

const { usd } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'pingproxies_topup', browser: 'chromium' });
try {
  await s.goto('https://dashboard.byteful.com/login');
  await humanIdlePause('deliberate');
  await s.page.locator('button:has-text("Continue with Google"), button:has-text("Sign in with Google")').filter({ visible: true }).first().click();
  const ok = await googleSso(s, login, { originHost: 'byteful.com' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  await humanIdlePause('long');
  // The home dashboard Add-balance modal exposes "Show More Payment
  // Options" that may reveal the saved card on file (****2430 visible
  // on /billing/payment-methods). The wallet variant of the modal
  // (entered from /billing/wallet) does NOT show that — only New Card +
  // Crypto. Going via home to reach the saved-card option.
  await s.page.goto('https://dashboard.byteful.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('deliberate');
  // Diag: enumerate what's actually visible on the wallet page.
  try {
    const walletState = await s.page.evaluate(() => {
      const visBtns = Array.from(document.querySelectorAll('button, [role="button"], a[href]')).filter(b => b.offsetParent && b.getBoundingClientRect().width > 30).map(b => `${b.tagName}:${(b.textContent || '').trim().slice(0, 50)}`);
      const visInputs = Array.from(document.querySelectorAll('input')).filter(i => i.offsetParent).map(i => `${i.type || 'text'}:${(i.name || i.placeholder || '').slice(0,30)}`);
      return { url: location.href, visBtns: visBtns.slice(0, 25), visInputs: visInputs.slice(0, 10) };
    });
    console.log('[diag] wallet page state:', JSON.stringify(walletState));
  } catch {}
  // The wallet page has TWO "Add balance" buttons: one in sidebar
  // (bottom-left), one in top-right of wallet content. Trying the
  // top-right wallet-page button — it may open a different modal that
  // properly fires the charge POST (the sidebar version's modal silently
  // aborts on Add-store-credit click across 14 iterations).
  const addBalanceBtns = s.page.locator('button:has-text("Add balance"), a:has-text("Add balance")').filter({ visible: true });
  const cnt = await addBalanceBtns.count().catch(() => 0);
  console.log(`[trajectory] found ${cnt} "Add balance" buttons; clicking the top-right one (last())`);
  const addBalanceBtn = addBalanceBtns.last();
  if (!(await addBalanceBtn.isVisible().catch(() => false))) { console.log('FAIL: "Add balance" button not visible'); process.exit(1); }
  await addBalanceBtn.evaluate((el) => (el).click());
  console.log('[trajectory] clicked "Add balance" via JS evaluate (top-right)');
  await humanIdlePause('deliberate');

  // Enumerate everything inside the modal containing the text "Credit card"
  // (or close variants) plus all clickable elements. v8s [role="tab"]
  // selector didnt match; need to know the real shape.
  try {
    const modalState = await s.page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const inDialog = (el) => dialogs.some(d => d.contains(el));
      const allBtns = Array.from(document.querySelectorAll('button, [role="button"], a[href]'));
      const modalBtns = allBtns.filter(b => inDialog(b) && b.offsetParent).map(b => `${b.tagName}[role=${b.getAttribute('role') || '-'}]:${(b.textContent || '').trim().slice(0, 60)}`);
      const allInputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).filter(i => i.offsetParent && inDialog(i)).map(i => `${i.tagName}:${i.type || 'text'}:${(i.name || i.placeholder || '').slice(0,30)}`);
      const ccCandidates = Array.from(document.querySelectorAll('*')).filter(el => inDialog(el) && el.offsetParent && /credit card/i.test(el.textContent || '') && el.children.length <= 4).slice(0, 12).map(el => `${el.tagName}[role=${el.getAttribute('role') || '-'}, class="${(el.className || '').toString().slice(0, 50)}"]:${(el.textContent || '').trim().slice(0, 60)}`);
      const iframes = Array.from(document.querySelectorAll('iframe')).filter(f => f.offsetParent).map(f => f.src.slice(0, 80));
      return { dialogCount: dialogs.length, modalBtns, modalInputs: allInputs, ccCandidates, iframes };
    });
    console.log('[diag] modal contents:', JSON.stringify(modalState));
  } catch (e) { console.log('[diag] err:', e.message?.slice(0, 80)); }

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) {
    // The pingproxies modal has a default amount value of 100 (cited from
    // modal HTML dump). v14s keyboard.type without proper clearing
    // appended to "100" producing "1010"/"10010" — invalid amount that
    // silently aborted the form. Use selectAll-then-type which Playwright
    // dispatches as a real key sequence React picks up.
    await amtIn.click();
    await amtIn.selectText().catch(() => {});
    await s.page.keyboard.press('Backspace');
    await humanType(s.page, String(usd), { delay: 80 });
    const actualValue = await amtIn.inputValue().catch(() => '');
    console.log(`[trajectory] amount input value after clear+type: "${actualValue}" (target: $${usd})`);
  }

  // Dump the full modal HTML so I can read actual selectors offline
  // instead of guessing. Writes to a known location for inspection.
  try {
    const modalHtml = await s.page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter(d => d.offsetParent);
      return dialogs.map(d => d.outerHTML).join('\n\n<!-- next dialog -->\n\n');
    });
    const fs = await import('node:fs');
    fs.writeFileSync(`${runRecordingsDir('pingproxies_topup')}/pingproxies_modal.html`, modalHtml);
    console.log('[trajectory] dumped modal HTML to recordings/<run>/pingproxies_topup/pingproxies_modal.html');
  } catch (e) { console.log('[diag] HTML dump err:', e.message?.slice(0, 80)); }

  

  // Click "Show More Payment Options" then the saved card option (cited
  // 2026-05-04: /billing/payment-methods has Mastercard ****2430 saved as
  // Default). The home-dashboard Add balance modal exposes this via the
  // "Show More Payment Options" expander. Without explicitly selecting a
  // saved card, the modal's "Add store credit" click is silently aborted
  // by byteful's React onClick — verified across 15 iterations.
  const showMore = s.page.locator('button:has-text("Show More Payment Options"), a:has-text("Show More Payment Options")').filter({ visible: true }).first();
  if (await showMore.isVisible().catch(() => false)) {
    await showMore.evaluate((el) => (el).click());
    console.log('[trajectory] clicked "Show More Payment Options"');
    await humanIdlePause('deliberate');
  }
  const savedCard = s.page.locator('label:has-text("2430"), [class*="radio"]:has-text("2430"), div:has-text("Mastercard"):has-text("2430")').filter({ visible: true }).first();
  if (await savedCard.isVisible().catch(() => false)) {
    await savedCard.evaluate((el) => (el).click());
    console.log('[trajectory] selected saved card ****2430');
    await humanIdlePause('short');
  } else {
    console.log('[trajectory] saved card ****2430 not visible — proceeding with default selection');
  }

  // CONFIRM: click the deposit-confirm button + watch for Stripe charge POST.
  let stripeChargeFired = false;
  s.ctx.on('request', (req) => { if (/api\.stripe\.com\/v1\/(payment_intents|setup_intents).*confirm/.test(req.url())) stripeChargeFired = true; });

  // Verified 2026-05-04 from modal diag: the confirm button is labeled
  // "Add store credit", and the modal also has an "Agree & Continue" step
  // (ToS agreement) that may need to be clicked first. The modal also has
  // top-row tabs (Cryptocurrency / Another payment option / Credit card)
  // and the v7 attempt clicking Add-store-credit alone closed the modal
  // without firing any Stripe POST — likely because Credit card tab was
  // visually highlighted but not actually the active form.
  const ccTab = s.page.locator('[role="tab"]:has-text("Credit card"), button:has-text("Credit card"), label:has-text("Credit card")').filter({ visible: true }).first();
  if (await ccTab.isVisible().catch(() => false)) { await ccTab.click({ force: true }).catch(() => {}); console.log('[trajectory] clicked Credit card tab'); await humanIdlePause('short'); }

  const agreeBtn = s.page.locator('button:has-text("Agree & Continue")').filter({ visible: true }).first();
  if (await agreeBtn.isVisible().catch(() => false)) { await agreeBtn.click({ force: true }).catch(() => {}); console.log('[trajectory] clicked "Agree & Continue"'); await humanIdlePause('deliberate'); }

  // Re-snapshot the modal AFTER Agree & Continue. v9 confirmed the modal
  // exists with "Add store credit" but the click closes the modal without
  // firing a charge. Need to know if Agree & Continue transitions the
  // modal to a card-entry / payment-confirm sub-view.
  try {
    const after = await s.page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      const inDialog = (el) => dialogs.some(d => d.contains(el));
      const allBtns = Array.from(document.querySelectorAll('button, [role="button"], a[href]'));
      const modalBtns = allBtns.filter(b => inDialog(b) && b.offsetParent).map(b => `${b.tagName}[${b.getAttribute('disabled') !== null ? 'DISABLED' : 'ena'}]:${(b.textContent || '').trim().slice(0, 60)}`);
      const modalInputs = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]')).filter(i => i.offsetParent && inDialog(i)).map(i => `${i.tagName}:${i.type || 'text'}:${(i.name || i.placeholder || '').slice(0,30)}=${(i.value || '').slice(0,12)}`);
      const iframes = Array.from(document.querySelectorAll('iframe')).filter(f => f.offsetParent).map(f => `${f.src.slice(0, 80)}`);
      return { dialogs: dialogs.length, modalBtns, modalInputs, iframes };
    });
    console.log('[diag] post-Agree state:', JSON.stringify(after));
  } catch {}

  const confirmBtn = s.page.locator('button:has-text("Add store credit")').filter({ visible: true }).first();
  if (!(await confirmBtn.isVisible().catch(() => false))) { console.log('FAIL: "Add store credit" button not visible inside modal'); process.exit(1); }
  // Real mouse click via box + page.mouse — bypasses React synthetic event
  // dispatch issues that swallowed the v6 force:true click without firing
  // any backend request (cited from network capture: zero charge POSTs
  // after the .click() return). Using page.mouse gives a real input event
  // with bubbling that React event listeners pick up.
  await confirmBtn.scrollIntoViewIfNeeded().catch(() => {});
  // v7-v12 cited: real-mouse click + force:true click + JS evaluate click
  // all left modal open with no Stripe POST. The React app's onClick fires
  // only on a "user gesture" — focus + Enter is the most reliable
  // Playwright path that React event listeners pick up.
  await confirmBtn.focus().catch(() => {});
  await humanIdlePause('short');
  await s.page.keyboard.press('Enter');
  console.log('[trajectory] focused + pressed Enter on Add store credit');
  for (let i = 0; i < 30 && !stripeChargeFired; i++) await humanIdlePause('short');
  if (stripeChargeFired) console.log(`PASS-CHARGED: Stripe payment_intents/confirm POST fired, url=${s.page.url().slice(0, 100)}`);
  else console.log(`FAIL: deposit-confirm clicked but no Stripe charge POST observed in 30s, url=${s.page.url().slice(0, 100)}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
