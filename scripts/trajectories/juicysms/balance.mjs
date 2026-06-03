// JuicySMS balance check via Google SSO. juicysms.com/login has
// "LOGIN WITH GOOGLE" button (and Cloudflare Turnstile).
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://juicysms.com/login';
const DISPLAY_NAME = 'JuicySMS';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'juicysms_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('long'); // Turnstile auto-solve window

  const popupPromise = s.page.waitForEvent('popup').catch(() => null);
  await s.page.locator('a:has-text("LOGIN WITH GOOGLE"), button:has-text("LOGIN WITH GOOGLE"), a:has-text("Login with Google"), button:has-text("Login with Google")').filter({ visible: true }).first().click();
  const popup = await Promise.race([popupPromise, new Promise(r => setTimeout(() => r(null), 8000))]);  // allow-raw-playwright: Promise.race deadline

  const ok = await googleSso(s, login, { originHost: 'juicysms.com', page: popup ?? undefined });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  for (let i = 0; i < 30; i++) { await humanIdlePause('short'); if (!/\/login/.test(s.page.url())) break; }
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
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
