// 2Captcha balance check via native form login. Google SSO path is gated
// on their proprietary __wCaptchaDiv widget which standard solvers do not
// solve, so we authenticate with native email+password (set by register.mjs).
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { parseBalanceFromText, patchServiceBalance } from '../_shared/services/google_sso.mjs';
import { pageCondition, pageSettled } from '../_shared/page/settled.mjs';
import { humanType } from '../../../dist/human/keyboard.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { getReceived, listReceived } from '../../_shared/resend-receiving.mjs';

const LOGIN_URL = 'https://2captcha.com/auth/login';
const DISPLAY_NAME = '2Captcha';

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) {
  console.log('FAIL: no 2Captcha credentials in DB. Run src/trajectories/twocaptcha/register.mjs to register an account.');
  process.exit(1);
}
console.log(`[trajectory] Using 2Captcha login: ${login.email}`);

const s = await WSession.start({ label: 'twocaptcha_balance', browser: 'chromium' });
try {
  await s.goto(LOGIN_URL);
  await pageSettled(s.page);

  await s.page.locator('input[name="email"]').fill(login.email);
  await s.page.locator('input[name="password"]').fill(login.password);

  // Once grecaptcha has loaded, execute() obtains a server-bound token
  // (pre-solved tokens are rejected ERROR_CAPTCHA_IS_INVALID); the response
  // field filling in is what ends the wait.
  await pageCondition(s.page, () => typeof window.grecaptcha?.execute === 'function');
  await s.page.evaluate(() => window.grecaptcha.execute('6Lfo9qojAAAAAPqqMn9QlAY2RBSVuEW63vDJ442M', { action: 'login' }));
  const tokenLen = await pageCondition(s.page, () => {
    const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
    return ta?.value && ta.value.length > 50 ? ta.value.length : false;
  });
  console.log(`[trajectory] grecaptcha token length=${tokenLen}`);

  // The form's own POST answering is the end of the login attempt; the page
  // then settles on wherever that answer sent it.
  const answered = s.page.waitForResponse((r) => r.request().method() === 'POST' && /2captcha\.com/.test(r.url()));
  await s.page.locator('button:has-text("Continue")').click();
  await answered;
  await pageSettled(s.page);
  console.log(`[trajectory] post-login url=${s.page.url()}`);
  if (/\/auth\/login/.test(s.page.url())) {
    console.log('FAIL: native form rejected creds (still on /auth/login).');
    process.exit(1);
  }

  // If account not yet confirmed, fetch the code from Resend and submit it.
  if (/\/auth\/confirm-email/.test(s.page.url())) {
    console.log('[trajectory] account needs email confirmation; fetching code from Resend');
    const list = await listReceived(10, login.email);
    const msg = list.data.find(m => m.to?.[0] === login.email && /2captcha/i.test(m.from || ''));
    if (!msg) { console.log('FAIL: no 2Captcha email found in Resend inbox'); process.exit(1); }
    const full = await getReceived(msg.id);
    const code = (full?.text || '').match(/\b(\d{6})\b/)?.[1];
    if (!code) { console.log('FAIL: could not extract 6-digit code from email'); process.exit(1); }
    console.log(`[trajectory] confirmation code=${code}`);
    // Fill the code into whatever input the page has
    // 2Captcha uses 6 split otp-1..otp-6 inputs; the form auto-submits when
    // the last one is filled. Use pressSequentially so each maxlength=1 input
    // receives exactly one digit and Vue's input handler advances focus.
    const otpFirst = s.page.locator('input[name="otp-1"]');
    await otpFirst.click();
    await humanType(s.page, code);
    await pageSettled(s.page);
    console.log(`[trajectory] post-confirm url=${s.page.url()}`);
  }

  // First-login: 2Captcha asks to choose worker vs customer role.
  // Two Next buttons exist (worker first, customer second). Click the second.
  if (/\/select-role/.test(s.page.url())) {
    console.log('[trajectory] selecting customer role (2nd Next button)');
    await s.page.locator('button:has-text("Next")').nth(1).click({ force: true }).catch(() => {});
    await pageSettled(s.page);
    console.log(`[trajectory] post-role url=${s.page.url()}`);
  }

  await pageSettled(s.page);
  const text = await s.page.evaluate(() => document.body.innerText);
  console.log(`[trajectory] dashboard text length=${text.length}`);
  const balance = parseBalanceFromText(text);
  if (balance == null) {
    const dir = runRecordingsDir('twocaptcha_balance');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'dashboard-text.txt'), text);
    try { writeFileSync(join(dir, 'dashboard.html'), await s.page.content()); } catch {}
    try { await s.page.screenshot({ path: join(dir, 'dashboard.png'), fullPage: true }); } catch {}
    console.log(`FAIL: 2Captcha balance regex did not match — full dashboard text dumped to ${dir}/`);
    process.exit(1);
  }
  console.log(`[trajectory] balance=$${balance}`);

  const patched = await patchServiceBalance(DISPLAY_NAME, balance);
  if (!patched) { console.log('FAIL: PATCH service_credentials failed'); process.exit(1); }
  console.log(`PASS: balance=$${balance} (persisted)`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
