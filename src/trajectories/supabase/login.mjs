// Supabase dashboard login through the exact Weles Supabase dashboard item.
// Run: node src/trajectories/supabase/login.mjs
import { readScopedLogin } from '../../_shared/scoped-secrets.mjs';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { pageSettled, submitAnswered } from '../_shared/page/settled.mjs';
import { humanFill } from '../../../dist/human/keyboard.js';

const SIGNIN_URL = 'https://supabase.com/dashboard/sign-in';
const SUCCESS_URL_RE =
  /supabase\.com\/dashboard\/(projects|organizations|org|account)/;

const login = readScopedLogin('supabaseDashboard');
console.log(
  `[trajectory] Using exact Supabase dashboard login: ${login.email}`,
);

const s = await WSession.start({
  label: 'supabase_login',
  browser: 'chromium',
});
try {
  await s.goto(SIGNIN_URL);
  await pageSettled(s.page);

  const emailInput = s.page
    .locator('input[name="email"], input[type="email"], input#email')
    .filter({ visible: true })
    .first();
  const pwInput = s.page
    .locator('input[name="password"], input[type="password"], input#password')
    .filter({ visible: true })
    .first();
  if (!(await emailInput.isVisible().catch(() => false))) {
    console.log('FAIL: email input not visible on sign-in page');
    process.exit(1);
  }
  if (!(await pwInput.isVisible().catch(() => false))) {
    console.log(
      'FAIL: password input not visible (account may be GitHub-SSO-only)',
    );
    process.exit(1);
  }

  await humanFill(s.page, emailInput, login.email);
  await pageSettled(s.page);
  await humanFill(s.page, pwInput, login.password);
  await pageSettled(s.page);

  // Submit via the primary submit button.
  const submitBtn = s.page
    .locator(
      'button[type="submit"]:has-text("Sign In"), button[type="submit"]:has-text("Sign in"), button:has-text("Sign in"), button:has-text("Sign In")',
    )
    .filter({ visible: true })
    .first();
  if (await submitBtn.isVisible().catch(() => false)) {
    try {
      await humanClickLocator(s.page, submitBtn);
    } catch {
      /* form may have submitted */
    }
  } else {
    console.log('FAIL: submit button not visible after credentials filled');
    process.exit(1);
  }

  // Supabase answers by routing away from /sign-in or with its own alert.
  const ERROR_SELECTOR =
    '[role="alert"], .error, [data-error="true"], p[class*="error" i]';
  await submitAnswered(
    s.page,
    /\/dashboard\/sign-in/,
    s.page.locator(ERROR_SELECTOR).filter({ hasText: /\S/ }).first(),
  );
  const url = s.page.url();
  if (SUCCESS_URL_RE.test(url)) {
    console.log(`PASS: landed on ${url}`);
    process.exit(0);
  }

  // Diagnostic: dump current url + visible error text.
  const errText = await s.page.evaluate((selector) => {
    for (const sel of selector.split(', ')) {
      const el = document.querySelector(sel);
      if (el && el.textContent?.trim()) return el.textContent.trim();
    }
    return null;
  }, ERROR_SELECTOR);
  console.log(
    `FAIL: supabase_login_refused at ${url}. error=${errText ?? '(none)'}`,
  );
  process.exit(1);
} catch (e) {
  console.log('FAIL:', e.message);
  process.exit(1);
} finally {
  await s.close();
}
