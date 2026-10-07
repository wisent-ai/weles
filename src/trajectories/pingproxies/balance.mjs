// Pingproxies (rebranded as Byteful) balance check via Google SSO.
// dashboard.byteful.com/login exposes "Continue with Google" button.
import { WSession } from '../../../dist/session/wsession.js';
import {
  googleSso,
  parseBalanceFromText,
  getGoogleSsoCreds,
} from '../_shared/services/google_sso.mjs';
import { patchEffectiveBalance } from '../_shared/services/proxy_probe.mjs';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled } from '../_shared/page/settled.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

const LOGIN_URL = 'https://dashboard.byteful.com/login';
const DISPLAY_NAME = 'Pingproxies';

const login = await getGoogleSsoCreds();
if (!login) {
  console.log('FAIL: no Google SSO credentials in DB');
  process.exit(1);
}
console.log(`[trajectory] Using Google SSO: ${login.email}`);

const s = await WSession.start({
  label: 'pingproxies_balance',
  browser: 'chromium',
});
try {
  await s.goto(LOGIN_URL);
  await pageSettled(s.page);

  const google = s.page
    .locator(
      'button:has-text("Continue with Google"), button:has-text("Sign in with Google")',
    )
    .filter({ visible: true })
    .first();
  if (!(await google.isEnabled()))
    throw new Error(`PINGPROXIES_GOOGLE_CONTROL_DISABLED: ${s.page.url()}`);
  await humanClickLocator(s.page, google);

  const ok = await googleSso(s, login, { originHost: 'byteful.com' });
  if (!ok)
    throw new Error(
      `PINGPROXIES_SSO_INCOMPLETE: Google sign-in did not return to byteful.com; observed ${s.page.url()}`,
    );

  await pageSettled(s.page);
  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = runRecordingsDir('pingproxies_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try {
      writeFileSync(join(dir, 'dashboard.html'), await s.page.content());
    } catch (error) {
      console.error('PINGPROXIES_DIAGNOSTIC_HTML_FAILED:', error);
    }
    try {
      await s.page.screenshot({
        path: join(dir, 'dashboard.png'),
        fullPage: true,
      });
    } catch (error) {
      console.error('PINGPROXIES_DIAGNOSTIC_SCREENSHOT_FAILED:', error);
    }
    throw new Error(
      `PINGPROXIES_BALANCE_NOT_FOUND: no labelled USD balance at ${s.page.url()}; dashboard text saved to ${dir}`,
    );
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchEffectiveBalance(DISPLAY_NAME, balance);
  if (!patched)
    throw new Error(
      `PINGPROXIES_BALANCE_NOT_PERSISTED: proxy record update did not succeed for ${DISPLAY_NAME}`,
    );
  console.log(
    `PASS: dashboard=$${balance} (effective balance written + probed)`,
  );
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
