// AntiCaptcha balance check via real browser login. Uses Google SSO since
// service_credentials row has login_email=lukasz.bartoszcze@gmail.com but no
// login_password — pull shared Google password via getGoogleSsoCreds().
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGIN_URL = 'https://anti-captcha.com/clients/';
const DISPLAY_NAME = 'AntiCaptcha';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'anticaptcha_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('deliberate');

  await s.page.locator('a:has-text("Continue with Google")').filter({ visible: true }).first().click();

  const ok = await googleSso(s, login, { originHost: 'anti-captcha.com' });
  if (!ok) { console.log('FAIL: Google SSO did not land back on anti-captcha.com'); process.exit(1); }

  await humanIdlePause('long');
  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    // Forensic dump on regex miss — full innerText, DOM, screenshot to
    // .work/anticaptcha_balance/ so the regex can be repaired against the
    // real page layout without re-running the trajectory.
    const dir = join(process.cwd(), '.work', 'anticaptcha_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); } catch {}
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
    console.log(`FAIL: AntiCaptcha balance regex did not match — full dashboard text dumped to ${dir}/`);
    process.exit(1);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) { console.log('FAIL: balance scraped but PATCH service_credentials failed'); process.exit(1); }
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
