// AntiCaptcha topup via Google SSO. Dry-run by default.
import { WSession } from '../../../dist/session/wsession.js';
import { googleSso, getGoogleSsoCreds } from '../_shared/services/google_sso.mjs';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';

const { usd, confirm } = topupOpts();
const login = await getGoogleSsoCreds();
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'anticaptcha_topup', browser: 'chromium' });
try {
  await s.goto('https://anti-captcha.com/clients/');
  await s.page.waitForTimeout(3000);
  await s.page.locator('a:has-text("Continue with Google")').filter({ visible: true }).first().click();
  const ok = await googleSso(s, login, { originHost: 'anti-captcha.com' });
  if (!ok) { console.log('FAIL: Google SSO did not complete'); process.exit(1); }

  await s.page.waitForTimeout(4000);
  await s.page.goto('https://anti-captcha.com/clients/finance/refill', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await s.page.waitForTimeout(5000);

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) {
    await amtIn.click(); await amtIn.fill(String(usd));
    console.log(`[trajectory] amount filled: $${usd}`);
  }

  if (!confirm) { await dryRunExit(s, 'anticaptcha', usd); process.exit(0); }
  console.log('FAIL: TOPUP_CONFIRM=1 not yet wired through AntiCaptcha checkout. Stop here for safety.');
  process.exit(1);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
