// SadCaptcha topup via native form login.
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { submitAnswered } from '../_shared/page/settled.mjs';

const { usd } = topupOpts();
const login = await getServiceLogin('SadCaptcha');
if (!login) {
  console.log('FAIL: no SadCaptcha creds. Run sadcaptcha/register.mjs first.');
  process.exit(1);
}

const s = await WSession.start({
  label: 'sadcaptcha_topup',
  browser: 'chromium',
});
try {
  await s.goto('https://www.sadcaptcha.com/login');
  await humanIdlePause('deliberate');
  await s.page.locator('input[name="username"]').fill(login.email);
  await s.page.locator('input[name="password"]').fill(login.password);
  await s.page.locator('input[type="submit"]').click();

  // The login is answered by leaving /login or by the form's own alert.
  const loginAlert = s.page
    .locator('[role="alert"], .alert-danger, .error')
    .filter({ visible: true })
    .first();
  if ((await submitAnswered(s.page, /\/login/, loginAlert)) === 'message') {
    console.log(
      `FAIL: login refused: ${(await loginAlert.innerText()).trim()}`,
    );
    process.exit(1);
  }

  // SadCaptcha pricing/buy section anchored on home.
  await s.page
    .goto('https://www.sadcaptcha.com/dashboard', {
      waitUntil: 'domcontentloaded',
    })
    .catch(() => {});
  await humanIdlePause('long');

  const amtIn = s.page
    .locator(
      'input[type="number"], input[name*="amount" i], input[inputmode="numeric"]',
    )
    .filter({ visible: true })
    .first();
  if (await amtIn.isVisible().catch(() => false)) {
    await amtIn.click();
    await amtIn.fill(String(usd));
    console.log(`[trajectory] amount filled: $${usd}`);
  }

  // CONFIRM: Find and click pay button
  const { findAndClickPayButton } = await import(
    '../_shared/services/topup_common.mjs'
  );
  const clicked = await findAndClickPayButton(s.page);
  if (!clicked) {
    console.log('FAIL: could not find pay/checkout button');
    process.exit(1);
  }
  await humanIdlePause('long');
  console.log(`PASS-CHARGED: checkout initiated, url=${s.page.url()}`);
} catch (e) {
  console.log('FAIL:', e.message);
  process.exit(1);
} finally {
  await s.close();
}
