// Bright Data balance check via real browser login. Account was created with
// Google SSO so the customer portal refuses password login ("You already
// created an account using Google"). Drive Google SSO; password stored in
// service_credentials.login_password IS the Google password.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText } from '../_shared/services/google_sso.mjs';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://brightdata.com/cp/login';
const DASH_URL  = 'https://brightdata.com/cp/api_example';
const DISPLAY_NAME = 'Bright Data';

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) { console.log('FAIL: no Bright Data credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using service login: ${login.email}`);

const s = await WSession.start({ label: 'brightdata_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('deliberate');

  await s.page.locator('button:has-text("Log in with Google")').filter({ visible: true }).first().click();

  const ok = await googleSso(s, login, { originHost: 'brightdata.com' });
  if (!ok) { console.log('FAIL: Google SSO did not land back on brightdata.com'); process.exit(1); }

  await humanIdlePause('deliberate');
  // Bright Data lists balance on the billing page.
  await s.page.goto('https://brightdata.com/cp/setting/billing', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = runRecordingsDir('brightdata_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); } catch {}
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
    console.log(`FAIL: Bright Data balance regex did not match — full dashboard text dumped to ${dir}/`);
    process.exit(1);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchEffectiveBalance(DISPLAY_NAME, balance);
  if (!patched) { console.log('FAIL: balance scraped but PATCH service_credentials failed'); process.exit(1); }
  console.log(`PASS: dashboard=$${balance} (effective balance written + probed)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
