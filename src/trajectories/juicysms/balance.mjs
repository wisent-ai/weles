// JuicySMS balance check via Google SSO. juicysms.com/login has
// "LOGIN WITH GOOGLE" button (and Cloudflare Turnstile).
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { popupOrNavigation, urlMatching } from '../_shared/page/settled.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://juicysms.com/login';
// The OAuth round trip lands back on a juicysms.com route other than /login.
const LANDED = /^https:\/\/(www\.)?juicysms\.com\/(?!login)/;
const DISPLAY_NAME = 'JuicySMS';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'juicysms_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  const googleButton = s.page.locator('a:has-text("LOGIN WITH GOOGLE"), button:has-text("LOGIN WITH GOOGLE"), a:has-text("Login with Google"), button:has-text("Login with Google")')
    .and(s.page.locator(':not(:disabled):not([aria-disabled="true"])')).filter({ visible: true }).first();
  await googleButton.waitFor({ state: 'visible' });
  const popup = await popupOrNavigation(s.page, /accounts\.google\.com/,
    () => humanClickLocator(s.page, googleButton));

  const ok = await googleSso(s, login, { originHost: 'juicysms.com', page: popup ?? undefined });
  if (!ok) throw new Error('Google SSO did not complete');

  await urlMatching(s.page, LANDED);
  if (/\/login/.test(s.page.url())) {
    await s.page.goto('https://juicysms.com/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await humanIdlePause('long');

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = runRecordingsDir('juicysms_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); } catch {}
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
    console.log(`FAIL: JuicySMS balance regex did not match — full dashboard text dumped to ${dir}/`);
    process.exit(1);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) { console.log('FAIL: PATCH service_credentials failed'); process.exit(1); }
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
