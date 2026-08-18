// Pingproxies (rebranded as Byteful) balance check via Google SSO.
// dashboard.byteful.com/login exposes "Continue with Google" button.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, parseBalanceFromText, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://dashboard.byteful.com/login';
const DISPLAY_NAME = 'Pingproxies';

const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO credentials in DB'); process.exit(1); }
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({ label: 'pingproxies_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await humanIdlePause('deliberate');

  await s.page.locator('button:has-text("Continue with Google"), button:has-text("Sign in with Google")').filter({ visible: true }).first().click();

  const ok = await googleSso(s, login, { originHost: 'byteful.com' });
  if (!ok) { console.log('FAIL: Google SSO did not land back on byteful.com'); process.exit(1); }

  await humanIdlePause('long');
  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = runRecordingsDir('pingproxies_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); } catch {}
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
    console.log(`FAIL: Pingproxies balance regex did not match — full dashboard text dumped to ${dir}/`);
    process.exit(1);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchEffectiveBalance(DISPLAY_NAME, balance);
  if (!patched) { console.log('FAIL: PATCH service_credentials failed'); process.exit(1); }
  console.log(`PASS: dashboard=$${balance} (effective balance written + probed)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
