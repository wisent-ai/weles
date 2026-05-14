// SadCaptcha balance check via native username+password form. No Google SSO
// offered. If service_credentials lacks creds, surface blocker.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { parseBalanceFromText, patchServiceBalance } from '../_shared/services/google_sso.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://www.sadcaptcha.com/login';
const DASH_URL = 'https://www.sadcaptcha.com/dashboard';
const DISPLAY_NAME = 'SadCaptcha';

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) {
  console.log('FAIL: SadCaptcha row in service_credentials has no login_email/login_password. SadCaptcha login is native form only — no Google SSO, no Discord OAuth. Register an account at sadcaptcha.com/register and PATCH the row with login_email + login_password before this trajectory can scrape.');
  process.exit(1);
}
console.log(`[trajectory] Using service login: ${login.email}`);

const s = await WSession.start({ label: 'sadcaptcha_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('deliberate');

  const userIn = s.page.locator('input[name="username"], input[type="email"]').filter({ visible: true }).first();
  await userIn.waitFor({ state: 'visible' });
  await userIn.click();
  await userIn.pressSequentially(login.email, { delay: 25 });

  const pwIn = s.page.locator('input[name="password"], input[type="password"]').filter({ visible: true }).first();
  await pwIn.waitFor({ state: 'visible' });
  await pwIn.click();
  await pwIn.pressSequentially(login.password, { delay: 25 });
  await pwIn.press('Enter');

  for (let i = 0; i < 20; i++) { await humanIdlePause('short'); if (!/\/login/.test(s.page.url())) break; }
  if (/\/login/.test(s.page.url())) { console.log('FAIL: still on /login after submit'); process.exit(1); }

  await s.page.goto(DASH_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await humanIdlePause('long');

  const text = await s.page.evaluate(() => document.body.innerText);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = join(process.cwd(), '.work', 'sadcaptcha_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); } catch {}
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
    console.log(`FAIL: SadCaptcha balance regex did not match — full dashboard text dumped to ${dir}/`);
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
