// Pingproxies (Byteful) topup via Google SSO. Dry-run by default.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';

const { usd, confirm } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'pingproxies_topup', browser: 'chromium' });
try {
  await s.goto('https://dashboard.byteful.com/login');
  await s.page.waitForTimeout(4000);
  await s.page.locator('button:has-text("Continue with Google"), button:has-text("Sign in with Google")').filter({ visible: true }).first().click();
  const ok = await googleSso(s, login, { originHost: 'byteful.com' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  await s.page.waitForTimeout(5000);
  // Verified 2026-05-04: the bottom-sidebar Add balance flow opens a
  // store-credit modal that requires NEW card entry every time (no
  // saved-card-for-store-credit option). The Wallet sub-page under
  // Billing may expose a different topup flow that uses the saved
  // subscription card on file.
  await s.page.goto('https://dashboard.byteful.com/billing/wallet', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await s.page.waitForTimeout(4000);
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
  await s.page.waitForTimeout(3500);

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
    await amtIn.click();
    // v7-v13 cited: Locator.fill() sets the DOM value but React's controlled
    // input ignores it (no charge POST fired across 7 different click
    // strategies). page.keyboard.type dispatches per-character keydown +
    // input events that React's value tracker accepts.
    await s.page.keyboard.press('Control+A').catch(() => {});
    await s.page.keyboard.press('Meta+A').catch(() => {});
    await s.page.keyboard.press('Backspace').catch(() => {});
    await s.page.keyboard.type(String(usd), { delay: 60 });
    console.log(`[trajectory] amount typed: $${usd}`);
  }

  if (!confirm) { await dryRunExit(s, 'pingproxies', usd); process.exit(0); }

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
  if (await ccTab.isVisible().catch(() => false)) { await ccTab.click({ force: true }).catch(() => {}); console.log('[trajectory] clicked Credit card tab'); await s.page.waitForTimeout(1500); }

  const agreeBtn = s.page.locator('button:has-text("Agree & Continue")').filter({ visible: true }).first();
  if (await agreeBtn.isVisible().catch(() => false)) { await agreeBtn.click({ force: true }).catch(() => {}); console.log('[trajectory] clicked "Agree & Continue"'); await s.page.waitForTimeout(2000); }

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
  await s.page.waitForTimeout(300);
  await s.page.keyboard.press('Enter');
  console.log('[trajectory] focused + pressed Enter on Add store credit');
  for (let i = 0; i < 30 && !stripeChargeFired; i++) await s.page.waitForTimeout(1000);
  if (stripeChargeFired) console.log(`PASS-CHARGED: Stripe payment_intents/confirm POST fired, url=${s.page.url().slice(0, 100)}`);
  else console.log(`FAIL: deposit-confirm clicked but no Stripe charge POST observed in 30s, url=${s.page.url().slice(0, 100)}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
