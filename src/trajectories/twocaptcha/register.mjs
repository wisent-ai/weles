// 2Captcha registration via native form. Bypasses the wCaptcha-gated Google
// button by using the native registration flow instead.
import { randomBytes } from 'node:crypto';
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { registrationPassword } from '../../../dist/utils/identity/password.js';
import { solverTaskResult } from '../_shared/captcha/solver_task.mjs';
import { writeServiceCredentials } from '../_shared/skarbiec/accounts.mjs';

const REGISTER_URL = 'https://2captcha.com/auth/register';
const RECAPTCHA_SITEKEY = '6Lfo9qojAAAAAPqqMn9QlAY2RBSVuEW63vDJ442M';
const EMAIL = `svc.2c.${randomBytes(3).toString('hex')}@wisentmedia.com`;
const password = registrationPassword();

console.log(`[trajectory] registering: ${EMAIL}`);

// CapSolver has no push or blocking answer: one read of the task's result,
// a task still being solved is a named error carrying its id.
async function solveInvisibleRecaptcha() {
  const key = process.env.CAPSOLVER_API_KEY;
  if (!key) throw new Error('twocaptcha_register: CAPSOLVER_API_KEY is not configured');
  const create = await (await fetch('https://api.capsolver.com/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: key, task: { type: 'ReCaptchaV2TaskProxyLess', websiteURL: REGISTER_URL, websiteKey: RECAPTCHA_SITEKEY, isInvisible: true } }) })).json();
  if (!create.taskId) throw new Error(`twocaptcha_register: CapSolver refused the task: ${create.errorCode ?? JSON.stringify(create)}`);
  return solverTaskResult({ name: 'capsolver', url: 'https://api.capsolver.com' }, key, create.taskId);
}

const s = await WSession.start({ label: 'twocaptcha_register', browser: 'chromium' });
try {
  await s.goto(REGISTER_URL);
  await humanIdlePause('long');

  await s.page.locator('input[name="email"]').fill(EMAIL);
  await s.page.locator('input[name="password"]').fill(password);
  await s.page.locator('input[name="agreement"]').check({ force: true });

  const token = await solveInvisibleRecaptcha();
  await s.page.evaluate((t) => {
    document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(el => el.value = t);
    if (typeof window.onRecaptchaSubmit === 'function') window.onRecaptchaSubmit(t);
  }, token);
  console.log('[trajectory] reCAPTCHA token injected');

  await s.page.locator('button:has-text("Create account")').click();
  await humanIdlePause('long');
  console.log(`[trajectory] post-register url=${s.page.url()}`);

  if (/\/register/.test(s.page.url())) {
    const err = await s.page.evaluate(() => document.body.innerText);
    console.log(`FAIL: still on /register. Body: ${err.replace(/\n/g, ' | ')}`);
    process.exit(1);
  }

  const item = writeServiceCredentials('2Captcha', { username: EMAIL, password });
  console.log(`PASS: registered ${EMAIL}; credentials persisted to ${item}`);
} catch (e) {
  console.log('FAIL:', e.message);
  process.exit(1);
} finally {
  await s.close();
}
