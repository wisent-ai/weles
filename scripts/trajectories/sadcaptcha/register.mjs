// One-off SadCaptcha registration. Creates an account with a generated
// password and persists it to service_credentials. Run once.
import { randomBytes } from 'node:crypto';
import { WSession } from '../../../dist/session/wsession.js';
import { CaptchaSolver } from '../../../dist/captcha/solver.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';

// SadCaptcha rejects gmail aliases; use a fresh wisentmedia.com mailbox instead.
const EMAIL = `svc.sad.${randomBytes(3).toString('hex')}@wisentmedia.com`;
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

const s = await WSession.start({ label: 'sadcaptcha_register', browser: 'chromium' });
try {
  await s.goto('https://www.sadcaptcha.com/register');
  await humanIdlePause('deliberate');
  await s.page.locator('input#username').click();
  await s.page.locator('input#username').pressSequentially(EMAIL, { delay: 25 });
  await s.page.locator('input#password1').click();
  await s.page.locator('input#password1').pressSequentially(password, { delay: 25 });
  await s.page.locator('input#password2').click();
  await s.page.locator('input#password2').pressSequentially(password, { delay: 25 });
  await s.page.locator('input#agreeToTerms').check();

  // Solve reCAPTCHA v2 (sitekey 6LdRfgQqAAAAAMmRfNPmuSunXUrrYxnrJLEhPrdV)
  const solver = new CaptchaSolver();
  const token = await solver.solveRecaptchaV2(s.page, '6LdRfgQqAAAAAMmRfNPmuSunXUrrYxnrJLEhPrdV');
  if (typeof token !== 'string') { console.log('FAIL: reCAPTCHA solve returned no token'); process.exit(1); }
  await s.page.evaluate((t) => {
    const ta = document.getElementById('g-recaptcha-response');
    if (ta) ta.value = t;
  }, token);
  console.log('[trajectory] reCAPTCHA token injected');

  await s.page.locator('input[type="submit"]').click();
  await humanIdlePause('long');
  console.log(`[trajectory] post-register url=${s.page.url()}`);

  if (/\/register/.test(s.page.url())) {
    const errText = await s.page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log(`FAIL: still on /register. Body: ${errText.replace(/\n/g, ' | ')}`);
    process.exit(1);
  }

  const databaseUrl = process.env.WELES_DATABASE_URL ?? '';
  const key = process.env.WELES_DATABASE_TOKEN ?? '';
  const r = await fetch(`${databaseUrl}/rest/v1/service_credentials?display_name=eq.SadCaptcha`, {
    method: 'PATCH',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ login_email: EMAIL, login_password: password, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) { console.log('FAIL: PATCH service_credentials returned', r.status); process.exit(1); }
  console.log(`PASS: registered ${EMAIL}; creds persisted to service_credentials.SadCaptcha`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
