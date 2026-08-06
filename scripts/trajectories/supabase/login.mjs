// Supabase dashboard login through the exact Weles Supabase dashboard item.
// Run: node scripts/trajectories/supabase/login.mjs
import { readScopedLogin } from '../../_shared/scoped-secrets.mjs';
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause, humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';

const SIGNIN_URL = 'https://supabase.com/dashboard/sign-in';
const SUCCESS_URL_RE = /supabase\.com\/dashboard\/(projects|organizations|org|account)/;

const login = readScopedLogin('supabaseDashboard');
console.log(`[trajectory] Using exact Supabase dashboard login: ${login.email}`);

const s = await WSession.start({ label: 'supabase_login', browser: 'chromium' });
try {
  await s.goto(SIGNIN_URL);
  await humanIdlePause('deliberate');

  const emailInput = s.page.locator('input[name="email"], input[type="email"], input#email').filter({ visible: true }).first();
  const pwInput = s.page.locator('input[name="password"], input[type="password"], input#password').filter({ visible: true }).first();
  if (!(await emailInput.isVisible().catch(() => false))) {
    console.log('FAIL: email input not visible on sign-in page');
    process.exit(1);
  }
  if (!(await pwInput.isVisible().catch(() => false))) {
    console.log('FAIL: password input not visible (account may be GitHub-SSO-only)');
    process.exit(1);
  }

  await humanFill(s.page, emailInput, login.email);
  await humanIdlePause('short');
  await humanFill(s.page, pwInput, login.password);
  await humanIdlePause('short');

  // Submit via the primary submit button.
  const submitBtn = s.page.locator('button[type="submit"]:has-text("Sign In"), button[type="submit"]:has-text("Sign in"), button:has-text("Sign in"), button:has-text("Sign In")').filter({ visible: true }).first();
  if (await submitBtn.isVisible().catch(() => false)) {
    try { await humanClickLocator(s.page, submitBtn); } catch { /* form may have submitted */ }
  } else {
    console.log('FAIL: submit button not visible after credentials filled');
    process.exit(1);
  }

  // Wait up to 30s for navigation away from /sign-in.
  for (let i = 0; i < 30; i++) {
    await humanIdlePause('short');
    const u = s.page.url();
    if (SUCCESS_URL_RE.test(u)) { console.log(`PASS: landed on ${u}`); process.exit(0); }
    if (/\/dashboard\/sign-in/.test(u) === false && /supabase\.com/.test(u)) {
      console.log(`[trajectory] off /sign-in but unexpected url=${u}`);
    }
  }

  // Diagnostic: dump current url + visible error text.
  const url = s.page.url();
  const errText = await s.page.evaluate(() => {
    const sels = ['[role="alert"]', '.error', '[data-error="true"]', 'p[class*="error" i]'];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (el && el.textContent?.trim()) return el.textContent.trim().slice(0, 200);
    }
    return null;
  });
  console.log(`FAIL: still on ${url} after 30s. error=${errText ?? '(none)'}`);
  process.exit(1);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
