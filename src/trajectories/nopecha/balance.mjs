// NopeCHA balance check via Google SSO. Sign-in modal opens after clicking
// the homepage "Sign in" anchor and offers "Continue with Google".
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled } from '../_shared/page/settled.mjs';

const HOME_URL = 'https://nopecha.com/';
const MANAGE_URL = 'https://nopecha.com/manage';
const DISPLAY_NAME = 'NopeCHA';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'nopecha_balance', browser: 'chromium' });
try {
  await s.goto(HOME_URL);
  await pageSettled(s.page);

  // Click homepage Sign in to open modal.
  await humanClickLocator(s.page, s.page.locator('a:has-text("Sign in")').first());
  const google = s.page.locator('button:has-text("Continue with Google")').filter({ visible: true }).first();
  await google.waitFor({ state: 'visible' });
  if (!(await google.isEnabled())) throw new Error(`NOPECHA_GOOGLE_CONTROL_DISABLED: ${s.page.url()}`);

  // "Continue with Google" navigates same-tab to accounts.google.com with
  // redirect_uri=https://api.nopecha.com/oauth/google/redirect (standard
  // server-side OAuth callback, no popup).
  await humanClickLocator(s.page, google);

  const ok = await googleSso(s, login, { originHost: 'nopecha.com' });
  if (!ok) throw new Error(`NOPECHA_SSO_INCOMPLETE: Google sign-in did not complete; observed ${s.page.url()}`);

  // After SSO, navigate to /manage to see keys + balance.
  const response = await s.page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded' });
  if (!response) throw new Error(`NOPECHA_MANAGE_RESPONSE_MISSING: ${s.page.url()}`);
  if (!response.ok()) throw new Error(`NOPECHA_MANAGE_HTTP_ERROR: HTTP ${response.status()} at ${response.url()}`);
  const responseError = await response.finished();
  if (responseError) throw new Error(`NOPECHA_MANAGE_RESPONSE_FAILED: ${response.url()}`, { cause: responseError });
  await pageSettled(s.page);

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] /manage text length=${text.length}`);

  if (/No active keys found/i.test(text)) {
    throw new Error(`NOPECHA_NO_ACTIVE_KEYS: provider displayed "No active keys found" at ${s.page.url()}`);
  }

  // NopeCHA shows credits rather than USD on its manage page:
  //
  //   Available credits
  //   2000 / 2000          <- first occurrence: remaining / total
  //   2000 / 2000          <- second occurrence: same line, repeated
  //
  // Pattern matches "Available credits" label followed by "<remaining> / <total>"
  // across the newline gap. The `[^0-9]*` allows label punctuation (`:`)
  // and the cross-line whitespace.
  const credMatch = text.match(/Available\s+credits[^0-9]*([0-9]+)\s*\/\s*([0-9]+)/i);
  let balance = credMatch ? Number(credMatch[1]) : null;
  if (balance == null) balance = parseBalanceFromText(text);  // fall-through for $ plans (legacy)
  if (balance == null) {
    // Forensic dump on regex miss — full innerText, DOM, screenshot. Reusable
    // shape for any other balance trajectory whose regex stops matching.
    const dir = runRecordingsDir('nopecha_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try {
      const html = await s.page.content();
      writeFileSync(join(dir, 'dashboard.html'), html);
    } catch (error) { console.error('NOPECHA_DIAGNOSTIC_HTML_FAILED:', error); }
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); }
    catch (error) { console.error('NOPECHA_DIAGNOSTIC_SCREENSHOT_FAILED:', error); }
    throw new Error(`NOPECHA_BALANCE_NOT_FOUND: no supported balance widget at ${s.page.url()}; dashboard text saved to ${dir}`);
  }
  if (credMatch) console.log(`[trajectory] balance=${balance}/${credMatch[2]} credits`);
  else console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) throw new Error(`NOPECHA_BALANCE_NOT_PERSISTED: service record update did not succeed for ${DISPLAY_NAME}`);
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
