// SadCaptcha topup via native form login.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';

const { usd, confirm } = topupOpts();
const login = await getServiceLogin('SadCaptcha');
if (!login) { console.log('FAIL: no SadCaptcha creds. Run sadcaptcha/register.mjs first.'); process.exit(1); }

const s = await WSession.start({ label: 'sadcaptcha_topup', browser: 'chromium' });
try {
  await s.goto('https://www.sadcaptcha.com/login');
  await s.page.waitForTimeout(2000);
  await s.page.locator('input[name="username"]').fill(login.email);
  await s.page.locator('input[name="password"]').fill(login.password);
  await s.page.locator('input[type="submit"]').click();

  for (let i = 0; i < 20; i++) { await s.page.waitForTimeout(1000); if (!/\/login/.test(s.page.url())) break; }
  if (/\/login/.test(s.page.url())) { console.log('FAIL: still on /login after submit'); process.exit(1); }

  // SadCaptcha pricing/buy section anchored on home.
  await s.page.goto('https://www.sadcaptcha.com/dashboard', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await s.page.waitForTimeout(5000);

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) { await amtIn.click(); await amtIn.fill(String(usd)); console.log(`[trajectory] amount filled: $${usd}`); }

  if (!confirm) { await dryRunExit(s, 'sadcaptcha', usd); process.exit(0); }
  console.log('FAIL: TOPUP_CONFIRM=1 not yet wired through SadCaptcha checkout. Stop here for safety.');
  process.exit(1);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally { await s.close(); }
