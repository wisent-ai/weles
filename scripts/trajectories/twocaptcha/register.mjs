// One-off 2Captcha registration via native form. Bypasses the wCaptcha-gated
// Google button by using the native registration flow instead.
import { randomBytes } from 'node:crypto';
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';

const REGISTER_URL = 'https://2captcha.com/auth/register';
const RECAPTCHA_SITEKEY = '6Lfo9qojAAAAAPqqMn9QlAY2RBSVuEW63vDJ442M';
const EMAIL = `svc.2c.${randomBytes(3).toString('hex')}@wisentmedia.com`;
const password = (() => {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghijkmnpqrstuvwxyz', digit = '23456789', special = '!@#$%&*';
  const pool = upper + lower + digit + special;
  const pick = (s) => s[randomBytes(1)[0] % s.length];
  const chars = [pick(upper), pick(lower), pick(digit), pick(special)];
  for (let i = 0; i < 12; i++) chars.push(pick(pool));
  for (let i = chars.length - 1; i > 0; i--) { const j = randomBytes(1)[0] % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
})();

console.log(`[trajectory] registering: ${EMAIL}`);

async function solveInvisibleRecaptcha() {
  const key = process.env.CAPSOLVER_API_KEY;
  if (!key) return null;
  const create = await fetch('https://api.capsolver.com/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: key, task: { type: 'ReCaptchaV2TaskProxyLess', websiteURL: REGISTER_URL, websiteKey: RECAPTCHA_SITEKEY, isInvisible: true } }) }).then(r => r.json()).catch(() => null);
  if (!create?.taskId) return null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));  // allow-raw-playwright: polling/rate-limit loop
    const res = await fetch('https://api.capsolver.com/getTaskResult', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: key, taskId: create.taskId }) }).then(r => r.json()).catch(() => null);
    if (res?.status === 'ready') return res.solution?.gRecaptchaResponse;
    if (res?.errorId) return null;
  }
  return null;
}

const s = await WSession.start({ label: 'twocaptcha_register', browser: 'chromium' });
try {
  await s.goto(REGISTER_URL);
  await humanIdlePause('long');

  await s.page.locator('input[name="email"]').fill(EMAIL);
  await s.page.locator('input[name="password"]').fill(password);
  await s.page.locator('input[name="agreement"]').check({ force: true });

  const token = await solveInvisibleRecaptcha();
  if (!token) { console.log('FAIL: invisible reCAPTCHA solve failed'); process.exit(1); }
  await s.page.evaluate((t) => {
    document.querySelectorAll('textarea[name="g-recaptcha-response"]').forEach(el => el.value = t);
    if (typeof window.onRecaptchaSubmit === 'function') window.onRecaptchaSubmit(t);
  }, token);
  console.log('[trajectory] reCAPTCHA token injected');

  await s.page.locator('button:has-text("Create account")').click();
  await humanIdlePause('long');
  console.log(`[trajectory] post-register url=${s.page.url()}`);

  if (/\/register/.test(s.page.url())) {
    const err = await s.page.evaluate(() => document.body.innerText.slice(0, 600));
    console.log(`FAIL: still on /register. Body: ${err.replace(/\n/g, ' | ')}`);
    process.exit(1);
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  const r = await fetch(`${supabaseUrl}/rest/v1/service_credentials?display_name=eq.2Captcha`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ login_email: EMAIL, login_password: password, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) { console.log('FAIL: PATCH service_credentials returned', r.status); process.exit(1); }
  console.log(`PASS: registered ${EMAIL}; creds persisted to service_credentials.2Captcha`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
