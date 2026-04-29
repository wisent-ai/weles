// 2Captcha topup via native form login (with grecaptcha.execute() trigger).
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { topupOpts, dryRunExit } from '../_shared/services/topup_common.mjs';

const { usd, confirm } = topupOpts();
const login = await getServiceLogin('2Captcha');
if (!login) { console.log('FAIL: no 2Captcha creds'); process.exit(1); }

const s = await WSession.start({ label: 'twocaptcha_topup', browser: 'chromium' });
try {
  await s.goto('https://2captcha.com/auth/login');
  await s.page.waitForTimeout(5000);
  await s.page.locator('input[name="email"]').fill(login.email);
  await s.page.locator('input[name="password"]').fill(login.password);

  for (let i = 0; i < 60; i++) {
    const ready = await s.page.evaluate(() => typeof window.grecaptcha?.execute === 'function').catch(() => false);
    if (ready) break;
    await s.page.waitForTimeout(500);
  }
  await s.page.evaluate(() => new Promise((resolve) => {
    try {
      window.grecaptcha.execute('6Lfo9qojAAAAAPqqMn9QlAY2RBSVuEW63vDJ442M', { action: 'login' });
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
        if (ta?.value && ta.value.length > 50) { clearInterval(iv); resolve(true); }
        if (tries > 60) { clearInterval(iv); resolve(false); }
      }, 500);
    } catch { resolve(false); }
  }));
  await s.page.locator('button:has-text("Continue")').click();
  await s.page.waitForTimeout(8000);

  // 2Captcha funds-add page.
  await s.page.goto('https://2captcha.com/pay', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await s.page.waitForTimeout(5000);

  const amtIn = s.page.locator('input[type="number"], input[name*="amount" i], input[inputmode="numeric"]').filter({ visible: true }).first();
  if (await amtIn.isVisible().catch(() => false)) { await amtIn.click(); await amtIn.fill(String(usd)); console.log(`[trajectory] amount filled: $${usd}`); }

  if (!confirm) { await dryRunExit(s, 'twocaptcha', usd); process.exit(0); }

  // CONFIRM: Find and click pay button
  const { findAndClickPayButton } = await import('../_shared/services/topup_common.mjs');
  const clicked = await findAndClickPayButton(s.page);
  if (!clicked) {
    console.log('FAIL: could not find pay/checkout button');
    process.exit(1);
  }
  await s.page.waitForTimeout(8000);
  console.log(`PASS-CHARGED: checkout initiated, url=${s.page.url().slice(0, 100)}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally { await s.close(); }
