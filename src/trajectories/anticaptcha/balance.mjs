// AntiCaptcha balance check via real browser login. Uses Google SSO since
// service_credentials row has a Google login_email but no
// login_password — pull shared Google password via getGoogleSsoCreds().
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled } from '../_shared/page/settled.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://anti-captcha.com/clients/';
const DISPLAY_NAME = 'AntiCaptcha';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'anticaptcha_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await pageSettled(s.page);

  const google = s.page.locator('a:has-text("Continue with Google")').filter({ visible: true }).first();
  if (!(await google.isEnabled())) throw new Error(`ANTICAPTCHA_GOOGLE_CONTROL_DISABLED: ${s.page.url()}`);
  await humanClickLocator(s.page, google);

  const ok = await googleSso(s, login, { originHost: 'anti-captcha.com' });
  if (!ok) throw new Error(`ANTICAPTCHA_SSO_INCOMPLETE: Google sign-in did not return to anti-captcha.com; observed ${s.page.url()}`);

  await pageSettled(s.page);
  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    // Forensic dump on regex miss — full innerText, DOM, screenshot to the
    // per-run recordings dir so the regex can be repaired against the
    // real page layout without re-running the trajectory.
    const dir = runRecordingsDir('anticaptcha_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); }
    catch (error) { console.error('ANTICAPTCHA_DIAGNOSTIC_HTML_FAILED:', error); }
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); }
    catch (error) { console.error('ANTICAPTCHA_DIAGNOSTIC_SCREENSHOT_FAILED:', error); }
    throw new Error(`ANTICAPTCHA_BALANCE_NOT_FOUND: no labelled USD balance at ${s.page.url()}; dashboard text saved to ${dir}`);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) throw new Error(`ANTICAPTCHA_BALANCE_NOT_PERSISTED: service record update did not succeed for ${DISPLAY_NAME}`);
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
