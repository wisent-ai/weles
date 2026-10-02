// Bright Data balance check via real browser login. Account was created with
// Google SSO so the customer portal refuses password login ("You already
// created an account using Google"). The exact dashboard login is resolved
// only through the dedicated Bright Data Skarbiec consumer.
import { getScopedGoogleLogin } from '../_shared/services/google_sso.mjs'
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText } from '../_shared/services/google_sso.mjs';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled } from '../_shared/page/settled.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://brightdata.com/cp/login';
const DASH_URL  = 'https://brightdata.com/cp/api_example';
const DISPLAY_NAME = 'Bright Data';

const login = await getScopedGoogleLogin('brightdataDashboard');
if (!login) { console.log('FAIL: dedicated Bright Data login is unavailable'); process.exit(1); }
console.log(`[trajectory] Using service login: ${login.email}`);

const s = await WSession.start({ label: 'brightdata_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await pageSettled(s.page);

  const google = s.page.locator('button:has-text("Log in with Google")').filter({ visible: true }).first();
  if (!(await google.isEnabled())) throw new Error(`BRIGHTDATA_GOOGLE_CONTROL_DISABLED: ${s.page.url()}`);
  await humanClickLocator(s.page, google);

  const ok = await googleSso(s, login, { originHost: 'brightdata.com' });
  if (!ok) throw new Error(`BRIGHTDATA_SSO_INCOMPLETE: Google sign-in did not return to brightdata.com; observed ${s.page.url()}`);

  // Bright Data lists balance on the billing page.
  const response = await s.page.goto('https://brightdata.com/cp/setting/billing', { waitUntil: 'domcontentloaded' });
  if (!response) throw new Error(`BRIGHTDATA_BILLING_RESPONSE_MISSING: ${s.page.url()}`);
  if (!response.ok()) throw new Error(`BRIGHTDATA_BILLING_HTTP_ERROR: HTTP ${response.status()} at ${response.url()}`);
  const responseError = await response.finished();
  if (responseError) throw new Error(`BRIGHTDATA_BILLING_RESPONSE_FAILED: ${response.url()}`, { cause: responseError });
  await pageSettled(s.page);

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = runRecordingsDir('brightdata_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); }
    catch (error) { console.error('BRIGHTDATA_DIAGNOSTIC_HTML_FAILED:', error); }
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); }
    catch (error) { console.error('BRIGHTDATA_DIAGNOSTIC_SCREENSHOT_FAILED:', error); }
    throw new Error(`BRIGHTDATA_BALANCE_NOT_FOUND: no labelled USD balance at ${s.page.url()}; dashboard text saved to ${dir}`);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchEffectiveBalance(DISPLAY_NAME, balance);
  if (!patched) throw new Error(`BRIGHTDATA_BALANCE_NOT_PERSISTED: proxy record update did not succeed for ${DISPLAY_NAME}`);
  console.log(`PASS: dashboard=$${balance} (effective balance written + probed)`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
