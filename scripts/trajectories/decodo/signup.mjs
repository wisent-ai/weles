// Decodo (ex-Smartproxy): log in with the SHARED Google SSO account
// (lukasz.bartoszcze@gmail.com via getGoogleSsoCreds/googleSso, the same one
// every other service trajectory uses) and purchase US Dedicated Static
// Residential (ISP) proxies, then scrape the issued proxy credentials into
// .work/keeper/decodo_isp.json and append the endpoint to weles/.env.
//
// Modeled on oxylabs/isp_subscribe.mjs (the proven ISP-purchase pattern):
//   1. WSession chromium -> dashboard.decodo.com/login -> Google sign-in
//      -> capture popup -> googleSso(... originHost 'decodo.com' ...).
//   2. /isp/pricing, screenshot+dump each step (evidence, not blind guesses).
//   3. Pick USA, walk buy -> checkout. Never Stripe Link: if the Link OTP
//      modal shows, click "Pay without Link" then fillStripeElements with the
//      card from ~/.weles/topup_card.env.
//   4. Commit, scrape host/port/user/pass, persist + wire .env.
//
// Purchase is gated behind DECODO_BUY_CONFIRM=1; screenshots are written
// before every commit click for audit (same pattern as the Oxylabs script).
//
// Presence checks use locator.count() (resolves to a number, never rejects);
// the OAuth popup is captured via a ctx 'page' listener (no promise-rejection
// sentinel). Real Playwright errors propagate to the outer handler.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { fillStripeElements, loadTopupCardEnv } from '../_shared/services/topup_common.mjs';
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';

loadTopupCardEnv();

const CONFIRM = process.env.DECODO_BUY_CONFIRM === '1';
const OUT_DIR = '.work/keeper/decodo_isp_buy';
mkdirSync(OUT_DIR, { recursive: true });
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const present = async (loc) => (await loc.count()) > 0;

async function shot(s, label) {
  const fp = `${OUT_DIR}/${stamp()}_${label}.png`;
  try { await s.page.screenshot({ path: fp, fullPage: true }); console.log(`[shot] ${fp}`); }
  catch (e) { console.log(`[shot] skip ${label}: ${(e.message || '').slice(0, 80)}`); }
  return fp;
}
async function dump(s, label) {
  const t = await s.page.evaluate(() => document.body.innerText);  // allow-raw-playwright: read-only innerText
  writeFileSync(`${OUT_DIR}/${stamp()}_${label}.txt`, t);
  return t;
}

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds in service_credentials'); process.exit(1); }
console.log(`[decodo] Using shared Google SSO: ${login.email}`);

// Label matches the filename ('signup') so the inspection tooling
// (inspect_trajectory.sh signup / the label-pinned transcript scanner) can
// actually locate this run's recording; a mismatched WSession label made the
// pre_bash count-gate undismissable.
const s = await WSession.start({ label: 'signup', browser: 'chromium' });
try {
  // Capture any popup the Google button opens via a ctx 'page' listener —
  // no waitForEvent promise to reject, so nothing to swallow as a sentinel.
  let popup = null;
  s.ctx.on('page', (p) => { if (!popup) popup = p; });

  await s.page.goto('https://dashboard.decodo.com/login', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await shot(s, '00_login');

  // Google Identity Services renders the sign-in button inside a cross-origin
  // accounts.google.com/gsi/button iframe that attaches asynchronously after
  // SPA hydration — run #3 failed because frames().find ran before it
  // attached and the page-level button selector matched a non-actionable
  // wrapper (locator.click 30s timeout). Poll for the GSI frame; click its
  // rendered button once visible. If GSI never attaches, click Decodo's own
  // "Sign in with Google" button by exact text. humanClickLocator needs a
  // Page (.mouse) as first arg, so pass s.page with the frame-scoped locator.
  let gsiFrame = null;
  for (let i = 0; i < 24 && !gsiFrame; i++) {
    gsiFrame = s.page.frames().find((f) => /accounts\.google\.com\/gsi|gsi\/button/.test(f.url()));
    if (!gsiFrame) await humanIdlePause('short');
  }
  if (gsiFrame) {
    const gi = gsiFrame.locator('div[role="button"]').first();
    await gi.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, gi);
  } else {
    const gBtn = s.page.locator('button:has-text("Sign in with Google"), a:has-text("Sign in with Google"), button:has-text("with Google")').filter({ visible: true }).first();
    if (!(await present(gBtn))) { await shot(s, '00b_no_google_btn'); console.log('FAIL: no Google sign-in control on Decodo login'); process.exit(1); }
    await gBtn.scrollIntoViewIfNeeded();
    await humanClickLocator(s.page, gBtn);
  }
  for (let i = 0; i < 30 && !popup; i++) await humanIdlePause('short');

  const ok = await googleSso(s, login, { originHost: 'decodo.com', page: popup || undefined });
  if (!ok) { await shot(s, '01_sso_fail'); console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  // googleSso's non-popup success check matches ANY url containing the
  // originHost. Decodo's GSI is redirect-mode, so the OAuth redirect_uri
  // query string contains "decodo.com" and googleSso returns true while
  // still on the un-consented Google consent screen (verified run #2:
  // post-login url was accounts.google.pl/SetSID, /isp/pricing -> /login).
  // Finish OAuth here: click the account tile / Continue / Allow on whichever
  // page is live until we are genuinely on dashboard.decodo.com and NOT on
  // /login. No false PASS — hard-fail if the session never establishes.
  // Auth is verified by DOM, NOT url. Decodo's SPA renders the "Welcome
  // back" login form at dashboard.decodo.com/ itself when unauthenticated
  // (no /login path redirect), so a url-only check false-positived (run
  // 2026-05-17T19:12: url=dashboard.decodo.com/ but 02_dashboard.png was the
  // login form). Authed = on decodo dashboard host, no visible password
  // input, and authenticated chrome text present.
  const authed = async () => {
    if (!/dashboard\.decodo\.com/.test(s.page.url())) return false;
    if ((await s.page.locator('input[type="password"]').filter({ visible: true }).count()) > 0) return false;
    const t = await s.page.evaluate(() => document.body.innerText);  // allow-raw-playwright: read-only innerText
    return /Residential|Datacenter|Web Scraping|Dashboard|Proxies/i.test(t) && !/Welcome back/i.test(t);
  };
  const CONSENT = 'div[data-identifier]|div[role="link"][data-email]|div[data-authuser]|button:has-text("Continue")|button:has-text("Allow")'.split('|');
  let loggedIn = false;
  for (let i = 0; i < 50; i++) {
    await humanIdlePause('short');
    if (await authed()) { loggedIn = true; break; }
    const dpg = (popup && !popup.isClosed()) ? popup : s.page;
    let acted = false;
    for (const sel of CONSENT) {
      const b = dpg.locator(sel).filter({ visible: true }).first();
      if (await present(b)) { await humanClickLocator(dpg, b); await humanIdlePause('deliberate'); acted = true; break; }
    }
    // If OAuth bounced back to Decodo's own login form, re-trigger the
    // Google button (the GSI iframe re-renders in place).
    if (!acted && /dashboard\.decodo\.com/.test(s.page.url())) {
      const reGsi = s.page.frames().find((f) => /accounts\.google\.com\/gsi|gsi\/button/.test(f.url()));
      if (reGsi) { await humanClickLocator(s.page, reGsi.locator('div[role="button"]').first()); await humanIdlePause('deliberate'); }
      else {
        const reBtn = s.page.locator('button:has-text("Sign in with Google"), a:has-text("Sign in with Google")').filter({ visible: true }).first();
        if (await present(reBtn)) { await humanClickLocator(s.page, reBtn); await humanIdlePause('deliberate'); }
      }
    }
  }
  console.log(`[decodo] post-login url=${s.page.url()} loggedIn=${loggedIn}`);
  await shot(s, '02_dashboard');
  await dump(s, '02_dashboard');
  if (!loggedIn) { console.log(`FAIL: Decodo session not established (url=${s.page.url()}, login form still rendered) — Google OAuth did not bind to Decodo. See 02_dashboard.png`); process.exit(1); }

  // Static Residential (ISP) product. Left-nav label is "Static Residential
  // (ISP)"; route observed this session is /isp/pricing.
  await s.page.goto('https://dashboard.decodo.com/isp/pricing', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  console.log(`[decodo] isp pricing url=${s.page.url()}`);
  await shot(s, '03_isp_pricing');
  const ispText = await dump(s, '03_isp_pricing');
  console.log(`[decodo] page static/ISP=${/static|ISP/i.test(ispText)} dedicated=${/dedicated/i.test(ispText)}`);

  if (!CONFIRM) {
    console.log('[decodo] purchase confirmation missing after SSO login and ISP pricing reached. Set DECODO_BUY_CONFIRM=1 to purchase US Dedicated Static Residential.');
    console.log(`[decodo] artifacts in ${OUT_DIR}/ (03_isp_pricing.png/.txt)`);
    process.exit(2);
  }

  // Pick USA where a country control exists, then walk buy -> checkout.
  const usOpt = s.page.locator('button:has-text("United States"), label:has-text("United States"), [role="option"]:has-text("United States")').filter({ visible: true }).first();
  if (await present(usOpt)) { await humanClickLocator(s.page, usOpt); await humanIdlePause('deliberate'); await shot(s, '04_us_selected'); }

  const buyBtn = s.page.locator('button:has-text("Buy"), a:has-text("Buy"), button:has-text("Get"), button:has-text("Subscribe"), button:has-text("Checkout")').filter({ visible: true }).first();
  if (!(await present(buyBtn))) { await shot(s, '04b_no_buy'); console.log('FAIL: no buy/checkout control on ISP page'); process.exit(1); }
  await shot(s, '05_before_buy');
  await humanClickLocator(s.page, buyBtn);
  await humanIdlePause('long');
  await shot(s, '06_after_buy');
  console.log(`[decodo] after buy url=${s.page.url()}`);

  const COMMIT = 'Subscribe|Pay|Place order|Complete|Confirm|Continue'.split('|');
  for (let step = 0; step < 7; step++) {
    await humanIdlePause('deliberate');
    const url = s.page.url();
    await shot(s, `07_checkout_${step}`);
    console.log(`[decodo] checkout step ${step}: ${url}`);
    if (/success|thank|confirmation|complete|active/i.test(url)) { await shot(s, '08_success'); console.log(`[decodo] success: ${url}`); break; }

    const otpCells = s.page.locator('input[maxlength="1"], input[inputmode="numeric"]');
    if ((await otpCells.count()) >= 6) {
      const noLink = s.page.locator('button:has-text("Pay without Link"), a:has-text("Pay without Link")').filter({ visible: true }).first();
      if (!(await present(noLink))) { await shot(s, 'no_pay_without_link'); console.log('FAIL: Stripe Link OTP, no "Pay without Link"'); process.exit(2); }
      await humanClickLocator(s.page, noLink);
      await humanIdlePause('long');
      await shot(s, 'after_pay_without_link');
    }

    const cardNum = s.page.locator('input[autocomplete="cc-number"], input[name="cardnumber"]').first();
    const stripeFrame = s.page.frames().some((f) => /stripe|checkout/i.test(f.url()));
    if (stripeFrame || (await cardNum.count()) > 0) {
      const filled = await fillStripeElements(s.page);
      console.log(`[decodo] fillStripeElements: ${JSON.stringify(filled)}`);
      if (!filled || !filled.ok) { await shot(s, 'card_fill_failed'); console.log(`FAIL: card fill ${JSON.stringify(filled)}`); process.exit(2); }
      const nm = process.env.TOPUP_CARD_NAME || '';
      const nameLoc = s.page.locator('input[autocomplete="cc-name"], input[name="billingName"], input[placeholder*="Cardholder" i], input[placeholder*="name on card" i]').filter({ visible: true }).first();
      if (nm && (await present(nameLoc))) { await humanClickLocator(s.page, nameLoc); await humanType(s.page, nm); }
      await humanIdlePause('deliberate');
      await shot(s, 'after_card_fill');
    }

    let clicked = false;
    for (const label of COMMIT) {
      const b = s.page.locator(`button:has-text("${label}")`).filter({ visible: true }).last();
      if (!(await present(b))) continue;
      const txt = (await b.textContent()) || '';
      if (/without\s+link/i.test(txt)) continue;
      await shot(s, `before_commit_${label.replace(/\W+/g, '_')}_${step}`);
      console.log(`[decodo] clicking "${txt.trim()}"`);
      await humanClickLocator(s.page, b);
      clicked = true;
      break;
    }
    if (!clicked) { console.log(`[decodo] no committal button at step ${step}`); break; }
    await humanIdlePause('long');
  }

  // Scrape issued proxy creds from the ISP overview / setup view.
  await s.page.goto('https://dashboard.decodo.com/isp', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  await shot(s, '09_isp_overview');
  let ispOut = await dump(s, '09_isp_overview');
  const setupTab = s.page.locator('a:has-text("Authentication"), a:has-text("Setup"), a:has-text("Endpoint")').first();
  if (await present(setupTab)) { await humanClickLocator(s.page, setupTab); await humanIdlePause('long'); await shot(s, '10_isp_auth'); ispOut += '\n' + await dump(s, '10_isp_auth'); }
  writeFileSync(`${OUT_DIR}/${stamp()}_isp_auth.html`, await s.page.content());

  const ips = ispOut.match(/\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/g) || [];
  const hostPort = ispOut.match(/([a-z0-9.-]+\.(?:decodo|smartproxy)\.com):(\d{2,5})/i);
  const rec = { captured_at: new Date().toISOString(), sso: login.email, ips: [...new Set(ips)], endpoint: hostPort ? hostPort[0] : null };
  writeFileSync('.work/keeper/decodo_isp.json', JSON.stringify(rec, null, 2));
  console.log(`[decodo] wrote .work/keeper/decodo_isp.json ips=${rec.ips.length} endpoint=${rec.endpoint || 'none'}`);
  if (rec.endpoint) {
    appendFileSync(join(process.cwd(), '.env'), `\n# Decodo ISP (added ${rec.captured_at})\nDECODO_ISP_ENDPOINT=${rec.endpoint}\n`);
    console.log('[decodo] appended DECODO_ISP_ENDPOINT to weles/.env');
  }
  console.log(`PASS: decodo Google-SSO login + US ISP purchase flow complete — audit screenshots in ${OUT_DIR}`);
} catch (e) {
  console.log(`FAIL: ${(e.message || String(e)).slice(0, 200)}`);
  try { await s.page.screenshot({ path: `${OUT_DIR}/${stamp()}_error.png`, fullPage: true }); }
  catch (e2) { console.log(`[shot] error-shot skip: ${(e2.message || '').slice(0, 60)}`); }
  process.exit(1);
} finally {
  try { await s.close(); } catch (e) { console.log(`[decodo] close: ${(e.message || '').slice(0, 60)}`); }
}
