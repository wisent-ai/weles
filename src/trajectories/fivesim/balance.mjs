// FiveSim (5sim.net) balance check via Google SSO. /login modal exposes
// "Sign in with Google" button alongside native form + Cloudflare Turnstile.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled, popupOrNavigation, urlMatching } from '../_shared/page/settled.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://5sim.net/login';
// The OAuth round trip lands back on a 5sim.net route other than /login.
const LANDED = /^https:\/\/(www\.)?5sim\.net\/(?!login)/;
const DISPLAY_NAME = 'FiveSim';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'fivesim_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  const googleButton = s.page.locator('button:has-text("Sign in with Google"), a:has-text("Sign in with Google")')
    .and(s.page.locator(':not(:disabled):not([aria-disabled="true"])')).filter({ visible: true }).first();
  await googleButton.waitFor({ state: 'visible' });
  const popup = await popupOrNavigation(s.page, /accounts\.google\.com/,
    () => humanClickLocator(s.page, googleButton));

  const ok = await googleSso(s, login, { originHost: '5sim.net', page: popup ?? undefined });
  if (!ok) throw new Error(`FIVESIM_SSO_INCOMPLETE: Google sign-in did not complete; observed ${s.page.url()}`);

  await urlMatching(s.page, LANDED);
  await pageSettled(s.page);
  if (!LANDED.test(s.page.url())) throw new Error(`FIVESIM_BALANCE_DESTINATION_MISMATCH: expected a 5sim account page outside login; observed ${s.page.url()}`);

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = runRecordingsDir('fivesim_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); }
    catch (error) { console.error('FIVESIM_DIAGNOSTIC_HTML_FAILED:', error); }
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); }
    catch (error) { console.error('FIVESIM_DIAGNOSTIC_SCREENSHOT_FAILED:', error); }
    throw new Error(`FIVESIM_BALANCE_NOT_FOUND: no labelled USD balance at ${s.page.url()}; dashboard text saved to ${dir}`);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) throw new Error(`FIVESIM_BALANCE_NOT_PERSISTED: service record update did not succeed for ${DISPLAY_NAME}`);
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
