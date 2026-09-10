// NopeCHA balance check via Google SSO. Sign-in modal opens after clicking
// the homepage "Sign in" anchor and offers "Continue with Google".
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, patchServiceBalance, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const HOME_URL = 'https://nopecha.com/';
const MANAGE_URL = 'https://nopecha.com/manage';
const DISPLAY_NAME = 'NopeCHA';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'nopecha_balance', browser: 'chromium' });
try {
  await s.goto(HOME_URL);
  await humanIdlePause('deliberate');

  // Click homepage Sign in to open modal.
  await s.page.locator('a:has-text("Sign in")').first().click();
  await humanIdlePause('deliberate');

  // "Continue with Google" navigates same-tab to accounts.google.com with
  // redirect_uri=https://api.nopecha.com/oauth/google/redirect (standard
  // server-side OAuth callback, no popup).
  await s.page.locator('button:has-text("Continue with Google")').filter({ visible: true }).first().click();

  const ok = await googleSso(s, login, { originHost: 'nopecha.com' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  // After SSO, navigate to /manage to see keys + balance.
  await humanIdlePause('long');
  await s.page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');

  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] /manage text length=${text.length}`);

  if (/No active keys found/i.test(text)) {
    console.log('FAIL: still showing "No active keys found" after Google SSO. Account is logged in but has no NopeCHA subscription/keys yet — buy a plan or generate a free trial key first.');
    process.exit(1);
  }

  // NopeCHA shows credits, not USD. Verified live 2026-05-08 against the
  // /manage page layout (full innerText dumped to the per-run recordings dir
  // by the forensic dump branch below):
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
    } catch {}
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
    console.log(`FAIL: NopeCHA balance regex did not match — full dashboard text dumped to ${dir}/`);
    process.exit(1);
  }
  if (credMatch) console.log(`[trajectory] balance=${balance}/${credMatch[2]} credits`);
  else console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) { console.log('FAIL: PATCH service_credentials failed'); process.exit(1); }
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
