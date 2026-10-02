// Capsolver balance check via Google SSO popup.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled, popupOrNavigation, urlMatching } from '../_shared/page/settled.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://dashboard.capsolver.com/passport/login';
const DISPLAY_NAME = 'Capsolver';
// Any URL that is no longer the passport login page.
const LEFT_LOGIN = /^(?!.*\/passport\/login)/;

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'capsolver_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await pageSettled(s.page);

  const google = s.page.locator('button:has-text("Sign In With Google")').filter({ visible: true }).first();
  if (!(await google.isEnabled())) throw new Error(`CAPSOLVER_GOOGLE_CONTROL_DISABLED: ${s.page.url()}`);
  const popup = await popupOrNavigation(s.page, /^https:\/\/accounts\.google\.com\//,
    () => humanClickLocator(s.page, google));
  if (popup) await pageSettled(popup);

  const ok = await googleSso(s, login, { originHost: 'capsolver.com', page: popup ?? undefined });
  if (!ok) throw new Error(`CAPSOLVER_SSO_INCOMPLETE: Google sign-in did not complete; observed ${s.page.url()}`);

  await urlMatching(s.page, LEFT_LOGIN);
  console.log(`[trajectory] post-login url=${s.page.url()}`);

  await pageSettled(s.page);
  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = runRecordingsDir('capsolver_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); }
    catch (error) { console.error('CAPSOLVER_DIAGNOSTIC_HTML_FAILED:', error); }
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); }
    catch (error) { console.error('CAPSOLVER_DIAGNOSTIC_SCREENSHOT_FAILED:', error); }
    throw new Error(`CAPSOLVER_BALANCE_NOT_FOUND: no labelled USD balance at ${s.page.url()}; dashboard text saved to ${dir}`);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) throw new Error(`CAPSOLVER_BALANCE_NOT_PERSISTED: service record update did not succeed for ${DISPLAY_NAME}`);
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
