// 2Captcha topup via native form login (with grecaptcha.execute() trigger).
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { pageCondition, pageSettled } from '../_shared/page/settled.mjs';

const { usd } = topupOpts();
const login = await getServiceLogin('2Captcha');
if (!login) { console.log('FAIL: no 2Captcha creds'); process.exit(1); }

const s = await WSession.start({ label: 'twocaptcha_topup', browser: 'chromium' });
try {
  await s.goto('https://2captcha.com/auth/login');
  await pageSettled(s.page);
  await s.page.locator('input[name="email"]').fill(login.email);
  await s.page.locator('input[name="password"]').fill(login.password);

  await pageCondition(s.page, () => typeof window.grecaptcha?.execute === 'function');
  await s.page.evaluate(() => window.grecaptcha.execute('6Lfo9qojAAAAAPqqMn9QlAY2RBSVuEW63vDJ442M', { action: 'login' }));
  await pageCondition(s.page, () => (document.querySelector('textarea[name="g-recaptcha-response"]')?.value?.length ?? 0) > 50);
  const answered = s.page.waitForResponse((r) => r.request().method() === 'POST' && /2captcha\.com/.test(r.url()));
  await s.page.locator('button:has-text("Continue")').click();
  await answered;
  await pageSettled(s.page);

  // 2Captcha funds-add page.
  await s.page.goto('https://2captcha.com/pay', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await pageSettled(s.page);

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) { await amtIn.click(); await amtIn.fill(String(usd)); console.log(`[trajectory] amount filled: $${usd}`); }

  

  // CONFIRM: Find and click pay button
  const { findAndClickPayButton } = await import('../_shared/services/topup_common.mjs');
  const clicked = await findAndClickPayButton(s.page);
  if (!clicked) {
    console.log('FAIL: could not find pay/checkout button');
    process.exit(1);
  }
  await pageSettled(s.page);
  console.log(`PASS-CHARGED: checkout initiated, url=${s.page.url().slice(0, 100)}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally { await s.close(); }
