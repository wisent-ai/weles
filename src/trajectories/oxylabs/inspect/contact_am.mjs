// Send the user-approved message to our Oxylabs Account Manager via the
// dashboard support chat. Reuses oxylabs/balance.mjs's exact vetted
// Google-SSO login, then opens the in-dashboard chat widget, types the
// fixed message (user-confirmed wording, no LinkedIn/automation naming for
// ToS safety), sends it, and screenshots the sent state for verification.
// This is a deliberate, user-authorized external send — the message text
// is a constant in this file and is not generated dynamically.
import { WSession } from '../../../../dist/session/wsession.js';
import { googleSso, getScopedGoogleLogin } from '../../_shared/services/google_sso.mjs'
import { humanIdlePause, humanClickLocator } from '../../../../dist/human/mouse.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MESSAGE = "Hi Karolis — our Dedicated ISP allocation (5 IPs, all within 135.132.64.0/19, AS33667, Santa Rosa) has become unusable for our workload: because all five sit in one contiguous /19 with no subnet diversity, once that range was flagged upstream the entire allocation went down together. Could you replace or reassign these five with clean IPs spread across multiple distinct /19 subnets — ideally different ASNs/cities — rather than another single adjacent block, so one upstream flag can't take out the whole set again? Also: can per-IP subnet/location diversity be guaranteed on our plan, and can the replacement IPs be confirmed unused/clean before assignment? Thanks.";

const LOGIN_URL = 'https://dashboard.oxylabs.io/';
const OUT = join(process.cwd(), '.work', 'oxylabs_contact_am');
mkdirSync(OUT, { recursive: true });

const login = await getScopedGoogleLogin('oxylabsDashboard');
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[contact-am] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'oxylabs_contact_am', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('long');

  const gsiFrame = s.page.frames().find(f => /gsi\/button/.test(f.url()));
  if (!gsiFrame) { console.log('FAIL: Oxylabs Google GSI iframe not found'); process.exit(1); }
  let popup = null;
  const popupPromise = s.page.waitForEvent('popup');
  await humanClickLocator(s.page, gsiFrame.locator('div[role="button"]').first());
  try {
    popup = await Promise.race([
      popupPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('popup-timeout')), 15000)),  // allow-raw-playwright: Promise.race deadline
    ]);
  } catch (e) { console.log(`FAIL: Google login popup did not open (${e.message})`); process.exit(1); }
  await popup.waitForLoadState('domcontentloaded');

  const ok = await googleSso(s, login, { originHost: 'oxylabs.io', page: popup });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 60; i++) {
    await humanIdlePause('short');
    if (!/^https:\/\/dashboard\.oxylabs\.io\/en\/?(\?.*)?$/.test(s.page.url())) break;
  }
  console.log(`[contact-am] post-login url=${s.page.url()}`);
  await humanIdlePause('long');
  await s.page.screenshot({ path: join(OUT, '00_dashboard.png'), fullPage: true });

  // Open the support chat launcher (Intercom-style bubble, bottom-right).
  const launchers = [
    s.page.locator('[class*="intercom-launcher"]').first(),
    s.page.locator('[aria-label*="hat" i], [aria-label*="essages" i], [aria-label*="elp" i]').first(),
    s.page.locator('iframe[name*="intercom"]').first(),
    s.page.locator('button:has-text("Chat"), button:has-text("Help")').first(),
  ];
  let opened = false;
  for (const L of launchers) {
    if (await L.isVisible().catch(() => false)) {
      await humanClickLocator(s.page, L);
      await humanIdlePause('deliberate');
      opened = true;
      console.log('[contact-am] clicked a chat launcher candidate');
      break;
    }
  }
  if (!opened) { await s.page.screenshot({ path: join(OUT, '01_no_launcher.png'), fullPage: true }); console.log(`FAIL: no chat launcher found — see ${OUT}/01_no_launcher.png`); process.exit(1); }
  await humanIdlePause('long');
  await s.page.screenshot({ path: join(OUT, '02_chat_open.png'), fullPage: true });

  // Find the composer (Intercom renders it in an iframe or inline).
  // Otty composer is a plain <input placeholder="Type your message...">,
  // possibly inside a widget iframe — earlier selector (textarea/
  // contenteditable/role=textbox only) missed it. Search page + every
  // frame; frame.locator can throw on a detached/cross-origin frame so
  // guard each probe.
  const COMPOSER_SEL = 'textarea, [contenteditable="true"], div[role="textbox"], input[placeholder*="message" i], input[placeholder*="Type" i], input[type="text"]';
  let composer = null;
  const scopes = [s.page];
  try { for (const f of s.page.frames()) scopes.push(f); } catch {}
  for (const scope of scopes) {
    try {
      const c = scope.locator(COMPOSER_SEL).first();
      if (await c.isVisible().catch(() => false)) { composer = c; break; }
    } catch { /* detached/cross-origin frame — skip */ }
  }
  if (!composer) { try { await s.page.screenshot({ path: join(OUT, '03_no_composer.png'), fullPage: true }); } catch {} console.log(`FAIL: chat composer not found — see ${OUT}/03_no_composer.png`); process.exit(1); }

  await humanClickLocator(s.page, composer);
  await humanIdlePause('short');
  await humanType(s.page, MESSAGE);
  await humanIdlePause('deliberate');
  await s.page.screenshot({ path: join(OUT, '04_typed.png'), fullPage: true });

  // Send: explicit send button if present, else Enter.
  const sendBtn = s.page.locator('[aria-label*="end" i], button:has-text("Send")').first();
  if (await sendBtn.isVisible().catch(() => false)) await humanClickLocator(s.page, sendBtn);
  else await s.page.keyboard.press('Enter');  // allow-raw-playwright: chat composers submit on Enter; no humanized atom for keypress-submit
  await humanIdlePause('long');
  await s.page.screenshot({ path: join(OUT, '05_sent.png'), fullPage: true });
  const after = await s.page.evaluate(() => document.body.innerText);  // allow-raw-playwright: read-only post-send verification
  writeFileSync(join(OUT, 'after_send.txt'), after);
  console.log(`PASS: message typed + send triggered — verify ${OUT}/05_sent.png shows it in the thread`);
} catch (e) {
  console.log('FAIL:', (e.message || String(e)).slice(0, 200));
  try { await s.page.screenshot({ path: join(OUT, 'error.png'), fullPage: true }); } catch {}
  process.exit(1);
} finally {
  await s.close();
}
